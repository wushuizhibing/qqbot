/**
 * 从聊天流水里提炼"关键事件"，写成个人日记。
 *
 * 跟印象提炼的区别：
 *   印象 —— 问"这个人是什么样"（性格、习惯）
 *   日记 —— 问"这个人身上发生过什么"（要求、冲突、约定）
 *
 * 成本控制：一次只问几个人，转写限长，输出要求 JSON 且条数封顶。
 */
import { parseJsonReply } from './dsh-agents.js';
import { MAX_PEOPLE_PER_RUN, TRANSCRIPT_LIMIT, EVENT_MAX_CHARS } from './diary.js';

/**
 * 把消息渲染成转写文本。
 * @param {Array<{ sender?: string, text?: string, time?: number }>} records
 */
export function renderTranscript(records) {
  return (records ?? [])
    .map((r) => {
      const who = String(r?.sender ?? '?');
      const text = String(r?.text ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return '';
      const t = r?.time ? new Date(Number(r.time)) : null;
      const stamp = t
        ? `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
        : '';
      return `${stamp} ${who}: ${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * 关键事件的提炼提示词。
 *
 * 重点在"什么算关键"——不说清楚，模型会把每句话都记下来，日记变成流水。
 *
 * @param {string[]} names
 * @param {string} transcript
 */
export function buildDiaryPrompt(names, transcript) {
  return [
    '你在帮一个群聊机器人维护"对群友的私人日记"。',
    `下面是一段群聊记录。请从里面挑出关于这几个人的**关键事件**：${names.join('、')}。`,
    '',
    '**什么算关键事件**（满足任一即可记）：',
    '- 对你（机器人）有要求的：让你改配置、让你安静、让你做什么事',
    '- 有情绪冲突或转折的：骂你、夸你、道歉、和解、闹别扭',
    '- 有承诺或约定的：说好明天开黑、答应帮谁做什么、约了什么时候',
    '- 透露了重要信息的：换了工作、搬家、生病、生日',
    '',
    '**什么不算**（千万别记）：',
    '- 纯闲聊、打招呼、表情包、附和（"哈哈""嗯""好"）',
    '- 普通的问答、查资料、指挥别人',
    '- 没有实质内容的抱怨',
    '',
    '**写法要求**：',
    `- 每条一句话，${EVENT_MAX_CHARS} 字以内，写清"发生了什么"`,
    '- 用第三人称，不要用"我"',
    '- 没有关键事件就返回空数组，**不要硬凑**',
    '',
    '只输出 JSON：',
    '{"events":[{"name":"昵称","text":"发生了什么"}]}',
    '',
    '群聊记录：',
    transcript,
  ].join('\n');
}

/**
 * 从模型回答里抠出 events 数组。
 * @param {string} reply
 * @returns {Array<{ name: string, text: string }>}
 */
export function parseDiaryReply(reply) {
  const parsed = parseJsonReply(reply) ?? {};
  const raw = Array.isArray(parsed.events) ? parsed.events : [];
  const out = [];
  for (const e of raw) {
    const name = String(e?.name ?? '').trim();
    const text = String(e?.text ?? '').trim();
    if (!name || !text) continue;
    // 模型偶尔会把"没有关键事件"写成一句人话，过滤掉
    if (/^(无|没有|暂无|空)$/.test(text)) continue;
    out.push({ name, text: text.slice(0, EVENT_MAX_CHARS) });
  }
  return out;
}

/**
 * 造一个日记提炼器。
 *
 * @param {{ agents?: { runOnce?: Function }, trace?: (event: string, data: any) => void }} deps
 * @param {{ buildPrompt?: Function, parseReply?: Function, render?: Function }} [helpers]
 */
export function createDiaryDistiller(deps = {}, helpers = {}) {
  const build = helpers.buildPrompt ?? buildDiaryPrompt;
  const parse = helpers.parseReply ?? parseDiaryReply;
  const render = helpers.render ?? renderTranscript;

  return {
    /**
     * @param {{ names: string[], records: any[], transcriptLimit?: number }} input
     * @returns {Promise<Array<{ name: string, text: string }>>}
     */
    async distill(input) {
      const names = (input?.names ?? []).filter(Boolean).slice(0, MAX_PEOPLE_PER_RUN);
      if (names.length === 0) return [];
      const limit = input?.transcriptLimit ?? TRANSCRIPT_LIMIT;
      const records = (input?.records ?? []).slice(-limit);
      const transcript = render(records);
      if (!transcript.trim()) return [];

      const prompt = build(names, transcript);
      const runner = deps.agents;
      if (!runner?.runOnce) throw new Error('子代理尚未就绪');

      const out = await runner.runOnce('群友日记', prompt, 60000);
      if (!out) return [];
      const events = parse(out);
      deps.trace?.('diary-distill', {
        asked: names,
        got: events.length,
        sample: events.slice(0, 3).map((e) => `${e.name}: ${e.text}`),
      });
      return events;
    },
  };
}
