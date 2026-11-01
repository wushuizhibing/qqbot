/**
 * DSH 侧桥接：把合并好的一批消息交给会话。
 *
 * 设计：两段式，各由一个子代理承担，互不直接调用，靠共享状态交接。
 *
 *   总结子代理：窗口历史 + 新消息 → 摘要
 *   思考子代理：摘要 + 新消息 + 路由 → 发送计划
 *   执行侧：按计划发出去
 *
 * 交给子代理的内容都是**纯数据**（字符串 / 可序列化对象），
 * 这样换成 DSH subagent 时直接当 prompt payload 传，不用改形状。
 */

import { toPlainText } from './message.js';

/**
 * 摘要：只存文字和关键事实，不存原始消息。
 * @typedef {object} Summary
 * @property {string} text        压缩后的上下文（人、事、态度、正在聊什么）
 * @property {string[]} facts     关键事实（名字、约定、别称等），便于思考子代理稳定引用
 * @property {number} covered     已经覆盖到第几条消息（按窗口内下标）
 * @property {string} [mood]      自己当下的情绪，一句话（谁引起的、多强）。空串 = 没有残留情绪
 * @property {number} [intensity] 情绪强度 0-10。0 = 没情绪，3 = 有点，6 = 明显，9+ = 上头
 * @property {number} [since]     这个情绪从什么时候开始（毫秒时间戳）。用来判断"放了很久了"
 */

/**
 * 情绪不单独建模：它就是摘要里的几个字段，跟着本来就要跑的总结子代理一起更新。
 *
 * 层次感来自两处，都不需要额外模型调用：
 *   1. intensity —— 同一句话，"有点烦"和"烦炸了"在语气上要能区分开；
 *   2. 老化（agedIntensity）—— 隔了几小时甚至几天，旧情绪该淡下去，不能一直摆脸色。
 */

/** 情绪字段的最大长度：一句话，塞进 prompt 不占地方 */
export const MOOD_MAX = 60;

/** 强度上限；超过按上限算，脏数据归零 */
export const MOOD_INTENSITY_MAX = 10;

/**
 * 强度放大系数：让情绪有起伏，别都挤在 1-4 这个安全区里。
 *
 * 背景：模型给强度天生保守（"有点不爽"永远是 3）。真人群友的情绪是有起落的
 * —— 被连着怼会真的烦起来，被夸会真的美一会儿。这里做两件事：
 *   1. 有情绪时给一个最低地板（FLAT_FLOOR），别全是"很淡"；
 *   2. 用平方根曲线放大，低段抬得多、高段不会一下子顶满（避免每句都"上头"）。
 * 0 仍然是 0（没情绪不能凭空造），上限钳在 10。
 */
export const INTENSITY_GAIN = 1.35;

/** 有情绪时的最低强度：表达出来就至少让人听得出。 */
export const FLAT_FLOOR = 2;

/**
 * 老化分界：超过这些毫秒，强度按比例打折（不是消失，是变淡）。
 *
 * 一天之后再加一档 0.08：0.15 在"先放大后衰减"的算法下顶格 10 × 0.15 = 1.5 → 取整 2，
 * 于是隔了一天的情绪永远停在 2，看起来散不掉。和 dsh-mood-kit 保持一致。
 */
export const MOOD_DECAY = Object.freeze([
  { afterMs: 6 * 60 * 60 * 1000, factor: 0.5 },    // 6 小时后：减半
  { afterMs: 12 * 60 * 60 * 1000, factor: 0.3 },   // 半天后：剩三成
  { afterMs: 24 * 60 * 60 * 1000, factor: 0.08 },  // 一天后：几乎没有
]);

/**
 * 规整强度：接受数字或数字字符串，钳到 0-10 整数；认不出来当 0。
 * @param {unknown} raw
 * @returns {number}
 */
export function normalizeIntensity(raw) {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MOOD_INTENSITY_MAX, Math.round(n)));
}

/**
 * 把模型给的原始强度放大成"实际语气强度"。
 *
 * 线性放大 1.35 倍，再加下限：
 *   1-2 抬到 2-3（有情绪就听得出）→ 3-4 抬到 4-5（明显）→ 7-8 抬到 9-10（重/上头）
 * 0 仍是 0（没情绪不能凭空造）；有情绪时至少 FLAT_FLOOR。
 * @param {unknown} raw
 * @returns {number}
 */
export function amplifyIntensity(raw) {
  const base = normalizeIntensity(raw);
  if (base <= 0) return 0;
  return normalizeIntensity(Math.max(FLAT_FLOOR, base * INTENSITY_GAIN));
}

/**
 * 强度 → 给模型看的一档语气提示。空串表示没情绪。
 * @param {number} intensity
 * @returns {string}
 */
export function intensityLabel(intensity) {
  const n = normalizeIntensity(intensity);
  if (n <= 0) return '';
  if (n <= 2) return '很淡（几乎不影响语气，别演）';
  if (n <= 4) return '轻（语气稍微变一点，别夸张）';
  if (n <= 6) return '明显（能听出来，但仍然别解释自己在不爽）';
  if (n <= 8) return '重（话更短，懒得展开，但别阴阳）';
  return '上头（几乎不想说长句，能一个字就一个字，但别伤人）';
}

/**
 * 情绪老化：按距离 since 多久，把强度打折。
 * 只降不升；没有 since 就按"刚发生"处理（拿不到起点时宁可当新鲜）。
 * @param {{ intensity?: number, since?: number }} mood
 * @param {number} [now]
 * @returns {number}
 */
export function agedIntensity(mood, now = Date.now()) {
  const base = normalizeIntensity(mood?.intensity);
  if (base <= 0) return 0;
  const since = Number(mood?.since);
  if (!Number.isFinite(since) || since <= 0) return base;
  const elapsed = Math.max(0, now - since);
  let factor = 1;
  for (const step of MOOD_DECAY) {
    if (elapsed >= step.afterMs) factor = step.factor;
  }
  return normalizeIntensity(base * factor);
}

/**
 * 规整情绪字段：单行、去引号、限长。脏数据一律当没有。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeMood(raw) {
  // 先去引号再判断"无"：模型常写成「无」/“没有”
  const text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[「『"'（(\[]+|[」』"'）)\]]+$/g, '')
    .trim();
  // 模型偶尔会把"没情绪"写成这些，别当成情绪带进 prompt
  if (/^(无|没有|没事|平静|正常|neutral|none|null|n\/a|-{1,2})$/i.test(text)) return '';
  return text.slice(0, MOOD_MAX);
}

/**
 * 发送计划：执行侧只认这个。
 * @typedef {object} SendPlan
 * @property {'group'|'private'} chatKind
 * @property {string} chatId
 * @property {import('./message.js').Segment[]} segments
 * @property {'reply'|'quote'|'none'} mode  怎么发：普通回复 / 引用 / 不发
 * @property {string} [quoteId]              mode=quote 时引用哪条
 */

/**
 * @typedef {object} TurnContext
 * @property {string} sessionKey
 * @property {object|null} route
 * @property {import('./message.js').Message[]} messages   这一批新消息
 * @property {import('./message.js').Message[]} window     会话窗口（最近的，含这一批）
 * @property {Summary|null} summary                        上一轮的摘要（如有）
 * @property {string} [mood]                               上一轮结束时的情绪（从摘要里取出来）
 * @property {Array<{ data: string, mediaType: string, name?: string }>} [images] 本批消息里的图片（base64），
 *   直接作为多模态输入交给思考子代理，不走文字描述
 */

/** 总结子代理接口 */
/**
 * @typedef {object} Summarizer
 * @property {(ctx: TurnContext, previous: Summary|null) => Promise<Summary>} summarize
 */

/** 思考子代理接口 */
/**
 * @typedef {object} Thinker
 * @property {(ctx: TurnContext, summary: Summary|null) => Promise<SendPlan|null>} think
 */

/** 执行侧接口 */
/**
 * @typedef {object} Sender
 * @property {(plan: SendPlan) => Promise<{ messageId?: string }>} send
 */

/**
 * @typedef {object} Bridge
 * @property {(ctx: TurnContext) => Promise<{ summary: Summary, plan: SendPlan|null }>} run
 */

/**
 * 把消息渲染成一段给子代理看的文字（不依赖协议格式）。
 *
 * 格式 `[时间] 群名片(QQ号): 内容`。
 * **必须带 QQ 号**：群记忆是按号记人的（群名片随时会改），只给名片模型就对不上档案。
 *
 * 引用回复特殊处理：协议里 reply 段只带被引消息的 id，原话得从这批消息里找。
 * 以前只渲染成"[回复]"，模型看不出在回谁 —— 于是出现"对方引用我一句话调侃，
 * 我回一句完全接不上"的情况。现在把被引的原话和说话人一起带出来。
 *
 * @param {import('./message.js').Message[]} messages
 * @param {import('./message.js').Message[]} [context] 更宽的上下文窗口：引用可能在上一批里
 * @returns {string}
 */
export function renderMessages(messages, context) {
  const list = messages ?? [];
  // 两个索引，都从"这批 + 更宽窗口"里建：
  //   byId  —— 引用段只给 id，用它还原本话
  //   nameOf —— @ 段只给 QQ 号，用它补名字
  const byId = new Map();
  const nameOf = new Map();
  for (const m of [...(context ?? []), ...list]) {
    if (!m) continue;
    if (m.id) byId.set(String(m.id), m);
    const sid = m.sender?.id;
    const sname = m.sender?.name;
    if (sid && sname) nameOf.set(String(sid), sname);
  }

  // 图片全局编号：跨消息连续递增，和 loadImagesFromMessages 的顺序一致。
  // 如果每条消息都从"图1"开始，几条消息各带一张图就全叫"图1"，模型分不清。
  let globalImgNo = 0;

  return list
    .map((m) => {
      const name = m.sender?.name ?? '';
      const id = m.sender?.id ?? '';
      const who = name && id ? `${name}(${id})` : name || id || '?';
      const at = new Date(m.time).toLocaleTimeString('zh-CN', { hour12: false });

      // 引用：把被引消息的原话和说话人带出来。
      // 不然渲染成"[回复]"，模型看不出在接谁的哪句话，容易答非所问。
      const replySeg = (m.segments ?? []).find((s) => s.type === 'reply');
      let quote = '';
      if (replySeg?.id) {
        const target = byId.get(String(replySeg.id));
        if (target) {
          const tName = target.sender?.name ?? target.sender?.id ?? '?';
          const tText = toPlainText(target.segments).replace(/\[回复\]/g, '').trim().slice(0, 60);
          quote = `（在回 ${tName} 的「${tText}」）`;
        } else {
          quote = '（在回前面某条）';
        }
      }

      // 正文：@ 段补上名字（协议只给号），图片编号，其余交给 toPlainText。
      //
      // 图片编号很重要：附在 prompt 后面的图只有"图1/图2"这样的名字，
      // 正文里标出"[图1]"才对得上"哪张图配哪句话、是谁发的"。
      let imgNo = globalImgNo;
      const body = (m.segments ?? [])
        .map((s) => {
          if (s.type === 'image') {
            imgNo += 1;
            globalImgNo = imgNo;
            return `[图${imgNo}]`;
          }
          if (s.type !== 'at') return toPlainText([s]);
          if (s.name) return `@${s.name}`;
          const known = s.id ? nameOf.get(String(s.id)) : '';
          return known ? `@${known}` : '@';
        })
        .join('')
        .replace(/\[回复\]/g, '');

      return `[${at}] ${who}: ${quote}${body}`;
    })
    .join('\n');
}

/**
 * 占位总结子代理：不调模型，只是把最近的消息压成一个粗糙摘要。
 * 真接 DSH 后换成 subagent 调用，输入仍是 ctx + previous。
 * @returns {Summarizer}
 */
export function createStubSummarizer() {
  return {
    async summarize(ctx, previous) {
      const people = [...new Set(ctx.messages.map((m) => m.sender?.name ?? m.sender?.id))].filter(Boolean);
      const lines = [
        previous?.text,
        `最近一批 ${ctx.messages.length} 条，来自 ${people.join('、') || '未知'}。`,
        `最新一条：${renderMessages(ctx.messages.slice(-1))}`,
      ].filter(Boolean);
      return {
        text: lines.join('\n'),
        facts: [...new Set([...(previous?.facts ?? []), ...people])],
        covered: ctx.window.length,
      };
    },
  };
}

/**
 * 占位思考子代理：不调模型，按"收到 N 条"给出一份合法计划。
 * 真接 DSH 后换成 subagent 调用，输出必须能过 validatePlan。
 * @param {{ decide?: (ctx: TurnContext, summary: Summary|null) => Promise<SendPlan|null> }} [options]
 * @returns {Thinker}
 */
export function createStubThinker(options = {}) {
  return {
    async think(ctx, summary) {
      if (options.decide) return options.decide(ctx, summary);
      const last = ctx.messages[ctx.messages.length - 1];
      if (!last) return null;
      const who = last.sender?.name ?? last.sender?.id ?? '有人';
      return {
        chatKind: last.chatKind,
        chatId: last.chatId,
        segments: [{ type: 'text', text: `收到 ${ctx.messages.length} 条，最近一条来自 ${who}` }],
        mode: 'reply',
      };
    },
  };
}

/**
 * 默认执行侧：调适配器的 send。
 * @param {{ send: (t: { chatKind: string, chatId: string, segments: any[] }) => Promise<any> }} adapter
 * @returns {Sender}
 */
export function createAdapterSender(adapter) {
  return {
    async send(plan) {
      return adapter.send({ chatKind: plan.chatKind, chatId: plan.chatId, segments: plan.segments });
    },
  };
}

/**
 * 校验发送计划：脏计划宁可不发。
 * 另外兜一层 NO_REPLY 哨兵：模型有时会把"这个我该说 NO_REPLY"直接当正文吐出来，
 * 那绝不该发进群里。
 * @param {unknown} plan
 * @returns {SendPlan|null}
 */
export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const p = /** @type {any} */ (plan);
  if (p.chatKind !== 'group' && p.chatKind !== 'private') return null;
  if (typeof p.chatId !== 'string' || !p.chatId) return null;
  if (!Array.isArray(p.segments) || p.segments.length === 0) return null;
  if (isSilentPlan(p.segments)) return null;
  const mode = p.mode === 'quote' || p.mode === 'none' ? p.mode : 'reply';
  return {
    chatKind: p.chatKind,
    chatId: p.chatId,
    segments: p.segments,
    mode,
    quoteId: mode === 'quote' && typeof p.quoteId === 'string' ? p.quoteId : undefined,
    // 心里那一下：只给面板看，不进群。
    // 必须在这里显式带出来 —— 这个函数是白名单式重建，没列出来的字段会被抹掉。
    // 之前就漏了它：思考子代理明明给了，走到这儿变空，面板上永远看不到。
    thought: typeof p.thought === 'string' ? p.thought.slice(0, 80) : '',
  };
}

/**
 * 整条计划是否只是个"不说话"哨兵（只有一个文本段，内容是 NO_REPLY 变体）。
 * @param {any[]} segments
 */
function isSilentPlan(segments) {
  const texts = segments.filter((s) => s?.type === 'text').map((s) => String(s.text ?? ''));
  if (texts.length !== segments.length || texts.length === 0) return false;
  const joined = texts.join('').trim().replace(/^[「『"'（(\[]+|[」』"'）)\]]+$/g, '').trim();
  return /^NO[_\s-]?REPLY$/i.test(joined);
}

/**
 * 组装两段式桥接。
 *
 * 注意：**"每 N 轮才总结一次"的节流不在这里做**。
 * 它在 index.js 的 summarizer 包装器里做（那里还有 carryMood 的情绪残留处理）。
 * 两处都做会相乘，实际变成每 N² 轮才总结一次 —— 情绪会卡死。
 *
 * @param {{ summarizer: Summarizer, thinker: Thinker, window: { get: (k: string) => any[], push: (k: string, m: any) => void } }} deps
 * @returns {Bridge}
 */
export function createTwoStageBridge({ summarizer, thinker, window }) {
  return {
    async run(ctx) {
      const previous = ctx.summary ?? null;
      // 每轮都交给 summarizer，节流由它自己决定（可能直接复用上一轮）
      const summary = await summarizer.summarize({ ...ctx, mood: previous?.mood ?? '' }, previous);

      // 交接给思考子代理：这一轮的上下文 + 刚更新的情绪（含量级）
      const mood = normalizeMood(summary?.mood);
      // 先老化（隔了很久的旧情绪不该还有原来的火气），再放大（别都挤在安全区里）
      const aged = agedIntensity({ intensity: summary?.intensity, since: summary?.since });
      const intensity = mood ? amplifyIntensity(aged) : 0;
      const raw = await thinker.think({ ...ctx, summary, mood, intensity }, summary);
      return { summary, mood, intensity, plan: validatePlan(raw) };
    },
  };
}
