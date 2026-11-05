/**
 * DSH 本地子代理实现。
 *
 * 用 DSH 自己的 sessionController 起一次性隔离会话，跑完读回复、归档清场：
 *   create({ cwd })  →  prompt({ sessionId, content })  →  等 turn/end  →  读最后一条 assistant
 *   →  archive(sessionId)
 *
 * 这样"总结子代理 / 思考子代理"是真的在 DSH 里跑的会话，不是占位实现。
 * ctx 是 DSH 的宿主上下文；拿不到所需服务时会在构造期就报错，不会跑到一半才发现。
 */

import { normalizeMood, normalizeIntensity, intensityLabel } from './bridge.js';
import { extractMeme } from './meme.js';

/**
 * @typedef {(chatKind: 'group'|'private', chatId: string, segments: any[]) => Promise<{ messageId?: string }>} SendFn
 */

/** 子代理最短超时：比这更短基本一定跑不完一轮。 */
const MIN_TIMEOUT_MS = 5000;

/**
 * 从 DSH 上下文中取子代理运行时。
 * @param {any} ctx
 * @param {{ cwd?: string, agentPreset?: string, model?: { provider: string, model: string, reasoningEffort?: string }, sessionPrefix?: string }} [options]
 */
export function createDshAgents(ctx, options = {}) {
  const ctrl = ctx?.sessionController ?? ctx?.get?.('sessionController');
  if (!ctrl) throw new Error('DSH sessionController 服务不可用，无法启动子代理会话');
  if (typeof ctrl.create !== 'function' || typeof ctrl.prompt !== 'function') {
    throw new Error('DSH sessionController 缺少 create/prompt，无法启动子代理会话');
  }

  const cwd = options.cwd ?? '';
  const agentPreset = options.agentPreset ?? '';
  // 可选：给子代理会话单独换模型（便宜档），不影响网页端的默认模型
  const model = options.model ?? null;
  /** @type {Map<string, Set<Function>>} */
  const turnEnd = new Map();
  const off = typeof ctx.on === 'function'
    ? ctx.on('session/event', (session, event) => {
        if (event?.type !== 'turn/end') return;
        const sid = session?.id;
        const set = turnEnd.get(sid);
        if (!set) return;
        for (const fn of [...set]) {
          try { fn(event) } catch { /* 单个监听器失败不影响其他 */ }
        }
      })
    : null;

  /**
   * 跑一个一次性会话，返回模型最后一段文本。
   * @param {string} name
   * @param {string} prompt
   * @param {number} [timeoutMs]
   * @param {Array<{ data: string, mediaType: string, name?: string }>} [images]
   *   图片以 base64 附上（多模态输入），模型直接看原图，不走文字描述
   * @returns {Promise<string>}
   */
  async function runOnce(name, prompt, timeoutMs = 120000, images = []) {
    const created = await ctrl.create({
      ...(cwd ? { cwd } : {}),
      ...(agentPreset ? { agentPreset } : {}),
    });
    const sessionId = String(created?.sessionId ?? '');
    if (!sessionId) throw new Error(`${name}: 子代理会话创建失败（没有 sessionId）`);

    // 给这条一次性会话单独指定模型（QQ 线用便宜的就够，不占用网页端的默认模型）
    if (model?.provider && model?.model && typeof ctrl.selectModel === 'function') {
      try {
        await ctrl.selectModel({
          sessionId,
          provider: model.provider,
          model: model.model,
          ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
        });
      } catch {
        // 换不动就用默认模型，别让整轮失败；调用方会从日志里看到 warn
      }
    }

    const done = new Promise((resolve, reject) => {
      const set = turnEnd.get(sessionId) ?? new Set();
      turnEnd.set(sessionId, set);
      const cleanup = () => {
        set.delete(handler);
        if (set.size === 0) turnEnd.delete(sessionId);
        clearTimeout(timer);
      };
      const handler = (event) => {
        cleanup();
        resolve(event);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${name}: 子代理超时（${Math.round(timeoutMs / 1000)}s）`));
      }, Math.max(MIN_TIMEOUT_MS, timeoutMs));
      timer.unref?.();
      set.add(handler);
    });

    // 有图就发多模态：文本在前，图片块跟在后面。
    // DSH 的 attachment 准入会检查模型是否支持 image 输入。
    const content = [{ type: 'text', text: prompt }];
    for (const im of Array.isArray(images) ? images : []) {
      if (im?.data && im.mediaType) {
        content.push({ type: 'image', mediaType: im.mediaType, data: im.data, name: im.name || 'qq-image' });
      }
    }

    try {
      await ctrl.prompt(
        { requestId: safeUuid(), sessionId, mode: 'queue', content },
        new AbortController().signal,
      );
      await done;
      return await lastAssistantText(ctrl, sessionId);
    } finally {
      // 一次性会话不留在侧栏；归档失败不影响结果
      try { await (ctrl.archive?.({ sessionId }) ?? ctrl.cancel?.({ sessionId })); } catch { /* ignore */ }
    }
  }

  return { runOnce, cwd, agentPreset, dispose: () => off?.() };
}

/** 读会话里最后一条 assistant 的纯文本。 */
async function lastAssistantText(ctrl, sessionId) {
  if (typeof ctrl.inspect !== 'function') return '';
  const ins = await ctrl.inspect(sessionId);
  const events = Array.isArray(ins?.events) ? ins.events : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev?.type !== 'assistant/message') continue;
    const content = (ev.data?.message ?? ev.message)?.content;
    if (!Array.isArray(content)) continue;
    return content
      .filter((c) => c?.type === 'text')
      .map((c) => String(c.text ?? ''))
      .join('\n')
      .trim();
  }
  return '';
}

function safeUuid() {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

/**
 * 表情包分类名 → 人话解释。
 *
 * 分类只是个英文标签（happy/sad/...），不解释的话模型只能瞎猜，
 * 经常出现"该发无语的场合发了开心的"。
 *
 * 新加分类时往这里补一条；没登记的会兜底成"（按名字理解）"。
 */
const MEME_TAG_GUIDE = {
  // ── 基础情绪 ──
  happy: '开心/卖萌/可爱 —— 用点头、比心、笑、蹦跶这类动作表示',
  sad: '难过/委屈/求安慰 —— 用捂脸、瘫着、哭、趴下这类动作表示',
  angry: '生气/凶/抗议 —— 用瞪、炸毛、拍桌、甩头这类动作表示',
  shy: '害羞 —— 用捂脸偷看、脸红、躲起来这类动作表示',
  confused: '困惑/愣住/问号 —— 用歪头、挠头、眨眼这类动作表示',
  surprised: '惊讶/被惊到 —— 用瞪大眼、后仰、举手这类动作表示',
  // ── 状态 ──
  daily: '日常 —— 吃喝发呆这类生活状态',
  sleep: '困/想睡 —— 趴着、打哈欠、躺平',
  work: '上班/忙碌/干活 —— 敲键盘、埋头、加班',
  tech: '技术/写代码/调 bug —— 对着屏幕、冒烟、脑洞',
  food: '吃/饿/馋 —— 吃东西、流口水',
  cpu: '脑子过载/宕机 —— 冒烟、死机、卡住',
  // ── 人际 ──
  affection: '亲近/喜欢/贴贴 —— 抱、蹭、比心',
  greeting: '打招呼/早上好 —— 挥手、点头',
  morning: '早上好 —— 起床、摊开手打招呼',
  like: '喜欢/点赞 —— 比心、竖大拇指',
  see: '看/在吗 —— 探头、张望',
  meow: '卖萌/撒娇 —— 喵、蹭',
  teasing: '逗/调戏/玩笑 —— 戳、坏笑',
  // ── 嘴替（都是玩笑，不是真攻击）──
  baka: '骂人傻（玩笑性质）—— 指着人、嫌弃脸，别真当人身攻击用',
  fool: '装傻/摆烂 —— 呆滞、摊手',
  sigh: '叹气/无奈 —— 吐气、肩膀垮下',
  givemoney: '要钱/哭穷 —— 伸手、可怜巴巴',
  money: '钱/花费/心疼 —— 数钱、皱眉',
  color: '问一句"什么颜色"之类的玩笑 —— 举色卡',
  portrait: '自拍/露面 —— 正脸对镜头',
};

/**
 * 把可用的分类渲染成一句解释。
 * @param {string[]} tags
 * @returns {string}
 */
export function renderMemeTagGuide(tags) {
  return (tags ?? [])
    .map((t) => {
      const key = String(t).toLowerCase();
      return MEME_TAG_GUIDE[key] ? `${t}=${MEME_TAG_GUIDE[key]}` : `${t}（按名字理解）`;
    })
    .join('；');
}

/**
 * 两句情绪是不是"换了层皮"的同一句。
 *
 * 判据用字符集合的 Jaccard 相似度：
 *   "被点名调侃，有点想回嘴"  vs  "被点名了，有点想回嘴"   → 很高的重合
 *   "被老王怼了"              vs  "有人喊开黑，来精神了"   → 几乎不重合
 *
 * 阈值 0.55：高到不会误杀真正的新情绪，低到能抓住"改两个字"的复读。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function tooSimilar(a, b) {
  const norm = (s) =>
    new Set(
      String(s ?? '')
        .replace(/[\s，。、！？,\.!?~～…—\-]/g, '')
        .split(''),
    );
  const A = norm(a);
  const B = norm(b);
  if (A.size === 0 || B.size === 0) return false;
  let inter = 0;
  for (const ch of A) if (B.has(ch)) inter += 1;
  const union = A.size + B.size - inter;
  return union > 0 && inter / union >= 0.55;
}

/**
 * 让子代理只输出一个 JSON 对象：把模型可能包在外面的 ```json 围栏、前后废话剥掉。
 * @param {string} text
 */
export function parseJsonReply(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 真·总结子代理：把"上一轮摘要 + 本批新消息"增量压成新摘要。
 *
 * 省 token 的两个关键：
 *   1. 不再每轮把整个窗口重发一遍，只发这批新消息（ctx.messages）；
 *   2. 跨轮延续靠 previous（上一轮摘要），而不是让模型重读历史。
 * @param {{ agents: { runOnce: (name: string, prompt: string, timeoutMs?: number) => Promise<string> } }} deps
 * @param {{ renderMessages: (m: any[]) => string }} helpers
 */
export function createLlmSummarizer(deps, helpers) {
  return {
    async summarize(ctx, previous) {
      const fresh = helpers.renderMessages(ctx.messages, ctx.window);
      const prompt = [
        '你是 QQ 群聊的上下文总结器。把下面这批新消息并入已有摘要。',
        '要求：只输出一个 JSON 对象，形如 {"text":"...","topic":"...","facts":["..."],"mood":"...","intensity":0}；text 不超过 200 字，讲清人在聊什么、情绪、有没有在等回复；facts 只放稳定事实（称呼、约定、身份）。',
        // ── 当前话题：单独一个字段 ──
        //
        // text 是"这段时间都发生了什么"，越滚越糊；topic 是"现在在聊什么"，
        // 短、具体、随时替换。两者分开，接话时才知道该接哪个茬。
        'topic 写**当前正在聊的那件事**，10 字以内，具体到能对上号（"红米手机推荐""周末开黑约时间"）。',
        '如果这批消息没推进任何话题（纯刷图、纯附和），topic 就沿用上一轮的；实在没有就写空串。',
        // ── 情绪：从这批消息里重新判断，不看历史 ──
        'mood 写你自己（群友身份）当下的情绪：一句完整的话，20 字以内，主语是你自己。',
        '**只根据"这批新消息"判断情绪**，不要推测之前发生过什么。',
        // 注意分寸：以前这里只写"大部分时候无情绪"，模型就一路保守到底，
        // 一晚上能全是"无"，星图永远不动 —— 那不是克制，是没反应。
        // 现在把"什么值得记"讲清楚：群里有人跟你互动，就该有一点反应。
        '**别人直接跟你说话、点你名、接你的话时，要有反应**：被搭话总归有点起伏（来劲、好奇、想接、被戳到），哪怕很淡也该记一笔。',
        '**完全无感**只留给这些情况：纯刷图、别人之间跟自己无关的闲聊、跟自己的话毫无关系的刷屏。',
        '有情绪时别怕写得淡：intensity 1-2 也算数，它表示"有点感觉但不多"，不是"没情绪"。',
        '**更不要写"又一张图""没人搭理我""有点没劲""发呆"这类自我沉浸的话** —— 那不是情绪，是心事，群里不这么说话。',
        // ── 强度：跳变，不是滑杆 ──
        'intensity 是 0-10 的强度：0=完全没情绪，1-2=很淡，3-4=轻，5-6=明显，7-8=重，9-10=上头。',
        '**强度要跟着事件的轻重跳**：被怼可能一下到 6，事过了就回 0；不是 2→3→4 那样爬。',
        '真被戳到、真觉得好笑、真烦了，就给 5 以上；被搭话、被点到、听到有趣的，给 2-4 就够。',
        '不要复述别人的话，不要把别人的原话塞进 mood（写了"被说 XX"这种半截引语就是错的）。',
        // ── 防复读：不给模型看上一轮的情绪文字，只给强度作参考 ──
        //
        // 以前把上一轮的情绪原句贴进 prompt，模型就会拿它当模板换词再吐一次
        // （"被点名调侃" → "被点名了" → "被点名了，探头看看"），节奏完全被带着走。
        // 现在只告诉它"上一轮大概多重"，文字让它从这批消息自己写。
        previous?.mood
          ? `（参考：上一轮你的情绪强度大约是 ${previous.intensity ?? 0}/10。别沿用上一轮的措辞，就按这批消息重新说一句。）`
          : '',
        previous ? `已有摘要：${previous.text}` : '（还没有摘要，这是第一轮）',
        '这批新消息：',
        fresh,
      ].filter(Boolean).join('\n');
      // deps.agents 可能是 getter（子代理要等 inject 回调才就绪），必须每次实时取，不能提前解构
      const runner = deps.agents;
      if (!runner?.runOnce) throw new Error('子代理尚未就绪');
      const out = await runner.runOnce('总结子代理', prompt, 60000);
      if (!out) throw new Error('总结子代理没有返回内容');
      const parsed = parseJsonReply(out) ?? {};
      // 情绪解析：模型说"无/没有/平静"时 intensity 必须归零，不能留上一轮的余温
      const rawMood = parsed.mood;
      let mood = normalizeMood(rawMood);

      // 防照抄：模型会把上一轮的情绪原样或"换个词"抄回来。
      //
      // 两道判据：
      //   ① 完全相同 → 直接当没给；
      //   ② 相似度很高（比如"被点名调侃，有点想回嘴" → "被点名了，有点想回嘴"）
      //      → 也算没给。prompt 里已经不给它看上一轮的原文了，但模型有时还是会
      //      顺着摘要里的描述编，这道是兜底。
      const copied = Boolean(mood && previous?.mood && (mood === previous.mood || tooSimilar(mood, previous.mood)));
      if (copied) {
        mood = '';
      }
      // 探针：能直接看出模型到底吐了什么、有没有被判定成照抄
      deps.trace?.('mood-parse', {
        sessionKey: ctx.sessionKey,
        raw: String(rawMood ?? '').slice(0, 60),
        normalized: normalizeMood(rawMood),
        previousMood: String(previous?.mood ?? '').slice(0, 60),
        copied,
      });

      let intensity = mood ? normalizeIntensity(parsed.intensity) : 0;
      // 强度跳变：低于 5 的边界值容易被模型当成"滑杆"慢慢爬，这里做一次离散化，
      // 让强度落在少数几档上（0/2/4/6/8/10），而不是 1,2,3,4 连着爬。
      if (intensity > 0) intensity = Math.round(intensity / 2) * 2;
      if (intensity > 10) intensity = 10;
      // since：情绪换新（或从无到有）才重新计时，延续同一情绪就保留原来的起点
      const sameMood = mood && previous?.mood === mood;
      const since = mood ? (sameMood && Number.isFinite(previous?.since) ? previous.since : Date.now()) : 0;
      return {
        text: typeof parsed.text === 'string' ? parsed.text : String(out).slice(0, 200),
        // 当前话题：没给就沿用上一轮的（纯刷图不该把话题冲掉）
        topic:
          typeof parsed.topic === 'string' && parsed.topic.trim()
            ? parsed.topic.trim().slice(0, 20)
            : String(previous?.topic ?? ''),
        facts: Array.isArray(parsed.facts) ? parsed.facts.map(String) : [...(previous?.facts ?? [])],
        covered: ctx.window.length,
        mood,
        intensity,
        since,
      };
    },
  };
}

/**
 * 真·思考子代理：根据摘要和新消息给出发送计划（JSON）。
 * @param {{ agents: { runOnce: (name: string, prompt: string, timeoutMs?: number) => Promise<string> } }} deps
 * @param {{ renderMessages: (m: any[]) => string }} helpers
 */
export function createLlmThinker(deps, helpers) {
  return {
    async think(ctx, summary) {
      const latest = ctx.messages[ctx.messages.length - 1];
      if (!latest) return null;
      const persona = deps.persona ? `${deps.persona}\n\n---\n` : '';
      // 记忆：这个群的档案 + 认识的人。按会话键查，不跨群串；带上本批消息供裁剪。
      const memory = deps.memoryFor ? String(deps.memoryFor(ctx.sessionKey, ctx.messages) ?? '') : '';
      // 关系：这条消息是谁说的，决定态度松紧（主人 vs 陌生人差别很大）
      const relHint = deps.relationshipFor ? String(deps.relationshipFor(ctx.sessionKey, latest) ?? '') : '';
      // 情绪：摘要顺带更新的那个字段。只影响语气，不当成不说话的理由。
      const mood = normalizeMood(ctx.mood ?? summary?.mood);
      const intensity = normalizeIntensity(ctx.intensity ?? summary?.intensity);
      const level = intensityLabel(intensity);
      const prompt = [
        persona,
        memory,
        '你在群里。根据摘要、记忆、关系、当下情绪和最新消息，决定要不要接话、接什么。',
        '消息行格式是「[时间] 群名片(QQ号): 内容」。认人用括号里的 QQ 号对上面的记忆，别只按名片猜。',
        relHint,
        mood
          ? `你现在的情绪：${mood}（强度 ${intensity}/10，${level}）。语气跟着强度走：越强越短越懒得展开，越淡就越接近平时。但别把情绪写进话里，别解释自己怎么了。`
          : '',
        // 心里不想接、嘴上还得给个交代时的处理。
        //
        // 踩过的坑：情绪写着"头皮发麻、不想接"，回复却是"喜欢啊 不然早跑了"——
        // 一句正确但没味的废话。原因是旧提示只有"越强越短越懒得展开"，
        // 而"懒得展开"被理解成"给个平平的正确答案"，情绪就白记了。
        '**不想接但又必须回的时候，别给正确的废话**：',
        '  比如被问"你喜欢自己吗"，心里是"又来，这问得烦" —— 这时候一句"喜欢啊 不然早跑了"就是废话。',
        '  该写成带态度的一小句：敷衍得有形状（"……喜欢吧，你问这干嘛"）、或者把球踢回去（"你猜"）。',
        '  原则：情绪是"不太想接"，那话里就该**看得出不太想接**，而不是说一句谁都能说的标准答案。',
        // 反骨是情绪系统的副作用，这里压一下：情绪影响语气，不影响你是不是抬杠
        '注意：情绪只改语气，不改态度。你本来是随和的群友，不是抬杠的——别因为情绪就变得阴阳、带刺、爱反问。',
        '关系也只改态度松紧，不改你是谁：熟可以损，不熟别主动开嘲。',
        '不要一上来就阴阳、带刺、爱反问；除非对方先怼你，否则语气正常一点。',
        // ── 输出格式：三个字段都必填 ──
        //
        // 之前 thought 一直是空，排查下来是模型只写了 send/text 两个字段 ——
        // 光说"不許省"压不住，得把模板摆出来、用完整示例、再重复一次。
        '════ 输出格式（严格照着来）════',
        '只输出一个 JSON 对象，**三个字段一个都不能少**：',
        '{"send": true, "text": "要说的话", "thought": "心里那一下"}',
        '',
        '完整示例：',
        '  输入：某人说「你们这样钓它不怕咬钩吗」',
        '  输出：{"send": true, "text": "6", "thought": "这货又来钓我，懒得咬"}',
        '',
        '再强调一次：**thought 必须写**。它不会发进群，只给面板看，所以实话实说就行。',
        '不想说话就 {"send": false, "text": "", "thought": "懒得接"}。',
        '**thought 和 text 得对得上**：thought 是"烦"，text 就不能是"好呀"这种没事人语气。',
        '',
        'thought 是这一下心里的念头：为什么这么接、为什么懒得展开、看完那条消息第一反应是什么。',
        '一句口语，20 字以内，不解释不总结。比如："这货又来钓我" / "没看懂，先看着" / "想怼回去但算了"。',
        '不要写成分析，也别写"我决定回复因为……"。',
        deps.memeTags?.length
          ? [
              `想发表情包就把 text 写成「[表情:${deps.memeTags[0]}]」这种，图会真的发出去；可用分类：${deps.memeTags.join('、')}。一期最多一张，普通闲聊三到五轮发一次就够，别刷屏。`,
              // 分类名对模型来说只是标签，得说清各自对应什么"动作/神态"
              `分类是什么意思：${renderMemeTagGuide(deps.memeTags)}`,
              // 表情包该怎么读：群里发图是**用动作/神态说话**，不是拿图里的东西说事。
              // 不写清楚的话，容易把"图上是一只鱼"理解成"在骂我是鱼"。
              '**表情包是拿动作和神态说话的**：挥手=打招呼、趴着=累、捂脸=无语、比心=喜欢。先想"这个动作像什么反应"，再决定发不发。',
              '**图里画的是什么动物/角色，不代表在说那个东西**：图上有条鱼，是"我很摆烂/我在摸鱼"这种状态，不是在骂人"你是鱼"。别把物种当骂人的话用，也别把别人发的图读成侮辱。',
            ].join('\n')
          : '',
        // 图片：逐张说清楚是谁发的、什么时候发的。
        // 以前只写一句"图附在后面"，几张图混在一起时模型根本不知道哪张对应谁的话。
        ctx.images?.length
          ? [
              `（这批消息带了 ${ctx.images.length} 张图，按顺序附在后面，逐张标注了发送人和时间：）`,
              ...ctx.images.map((im, i) => {
                const who = im.sender ? `${im.sender}${im.senderId ? '(' + im.senderId + ')' : ''}` : '?';
                const when = im.at ? new Date(im.at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
                return `  图${i + 1}：${who} 发的${when ? '（' + when + '）' : ''}`;
              }),
              '看清是谁发的再决定怎么接；看不懂就当没看见，别猜。',
            ].join('\n')
          : '',
        // ── 三层上下文 ──
        //
        // 之前只有"摘要 + 最新消息"两段。摘要会越滚越糊，中间那些话的**原词**就丢了，
        // 而接话往往靠的就是原词（"那个红米""刚才说的那个"）。
        //
        // 所以补中间一层：把窗口里**还没被这批消息覆盖的那部分原话**也放进去。
        // 层与层不重复：摘要讲结论，原话给措辞，最新消息是要回的对象。
        summary ? `【当前话题】${summary.topic || '（没有明确话题）'}` : '',
        summary ? `【之前聊的】${summary.text}` : '',
        (() => {
          // 窗口里剔除本批消息后剩下的，就是"刚说过、模型没直接看到"的原话
          const batchIds = new Set((ctx.messages ?? []).map((m) => String(m?.id ?? '')));
          const earlier = (ctx.window ?? []).filter((m) => !batchIds.has(String(m?.id ?? '')));
          if (earlier.length === 0) return '';
          // 只留最后 N 条：再往前的信息摘要里已经有了
          const keep = earlier.slice(-Number(deps.recentContextMax ?? 20));
          const rendered = helpers.renderMessages(keep, ctx.window);
          return rendered.trim() ? `【刚说过的话】\n${rendered}` : '';
        })(),
        '【要接的消息】',
        helpers.renderMessages(ctx.messages, ctx.window),
      ].filter(Boolean).join('\n');
      // 同 summarize：agents 可能是 getter，实时取
      const runner = deps.agents;
      if (!runner?.runOnce) throw new Error('子代理尚未就绪');
      // 有图就一起递过去，让模型自己看，别用文字描述转一手
      const images = ctx.images ?? [];
      const out = await runner.runOnce('思考子代理', prompt, 90000, images);
      if (!out) throw new Error('思考子代理没有返回内容');
      const parsed = parseJsonReply(out) ?? {};
      // 探针：模型到底吐了什么。thought 一直是空的时候，靠这个判断是
      // ① 模型没按格式输出，还是 ② 我们解析漏了字段。
      deps.trace?.('think-parse', {
        sessionKey: ctx.sessionKey,
        raw: String(out).slice(0, 400),
        keys: Object.keys(parsed),
        thought: String(parsed.thought ?? '').slice(0, 60),
      });
      if (parsed.send === false) return null;
      const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      if (!text) return null;
      // 人格里让它"不想说话就输出 NO_REPLY"，这句是给 DSH 看的哨兵，
      // 绝不能当成正文发进群里。
      if (isNoReply(text)) return null;
      // 心里想的那一句（为什么这么回 / 为什么回这么短），只记在面板流水里，
      // 不进群。模型没给就空着 —— 别编。
      const thought = String(parsed.thought ?? '').trim().slice(0, 80);
      // 表情包：模型可以只回一个「[表情:happy]」，也可以文字带表情，图是真文件
      const meme = deps.memeLib ? extractMeme(text, deps.memeLib) : null;
      if (meme?.usedMeme) {
        // 纯表情没配到图（图库空了/分类不存在）：这轮就当没说，别发空消息
        if (!meme.segments.length) return null;
        return {
          chatKind: latest.chatKind,
          chatId: latest.chatId,
          segments: meme.segments,
          mode: 'reply',
          thought,
        };
      }
      return {
        chatKind: latest.chatKind,
        chatId: latest.chatId,
        segments: [{ type: 'text', text }],
        mode: 'reply',
        thought,
      };
    },
  };
}

/** 模型用来表示"这轮不说话"的几种写法。 */
const NO_REPLY_PATTERNS = [/^NO[_\s-]?REPLY$/i, /^\[?\s*NO[_\s-]?REPLY\s*\]?$/i];

/**
 * 判断一段文本是不是"不说话"哨兵。
 * 容忍全角括号、多余引号和首尾空白。
 * @param {string} text
 */
export function isNoReply(text) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/^[「『"'（(\[]+|[」』"'）)\]]+$/g, '')
    .trim();
  return NO_REPLY_PATTERNS.some((re) => re.test(cleaned));
}
