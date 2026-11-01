/**
 * 群友印象的"提炼"这一步：读一段聊天流水，让模型说说这些人现在什么样。
 *
 * 和「自动更新」的关系：
 *   impressions.js —— 只管文本合并（纯函数，好测）
 *   本文件         —— 管怎么问模型、怎么兜底（需要 agents）
 */

import { cleanImpression, MAX_PEOPLE_PER_RUN } from './impressions.js';
import { parseJsonReply } from './dsh-agents.js';

/** 一次喂给模型多少条流水 */
export const TRANSCRIPT_LIMIT = 80;

/**
 * 把流水渲染成给模型看的一段话。
 * @param {Array<{ sender?: string, senderId?: string, text?: string, time?: number }>} records
 */
export function renderTranscript(records) {
  return (records ?? [])
    .filter((r) => String(r?.text ?? '').trim())
    .map((r) => {
      const who = String(r.sender ?? r.senderId ?? '?');
      const text = String(r.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      return `${who}: ${text}`;
    })
    .join('\n');
}

/**
 * 给模型的任务说明。
 *
 * 要点：只让它**总结人的特征**，别写事件、别写八卦、别编。
 * @param {string[]} names 这次要更新的人
 * @param {string} transcript
 * @param {string} [currentMemory] 现有印象，让它在旧的基础上改而不是从零瞎猜
 */
export function buildImpressionPrompt(names, transcript, currentMemory) {
  return [
    '你在帮一个群聊机器人维护"对群友的印象"。',
    `下面是一段群聊记录。请据此更新这几个人的印象：${names.join('、')}。`,
    '',
    '要求：',
    '- 每人一句话，30 字以内，写**这个人是什么样**（性格、说话习惯、爱聊什么、怎么相处）。',
    '- 只写从记录里能看出来的，看不出来就别写，别编。',
    '- 不要写具体事件（"他昨天说了XX"），那是流水不是印象。',
    '- 不要写外貌、不要写评价好坏，只写"跟这个人打交道时该注意什么"。',
    '- 旧印象可以参考，但记录里明显不符就以记录为准。',
    '',
    currentMemory ? `现有印象：\n${currentMemory}` : '（还没有任何印象）',
    '',
    '只输出 JSON：{"people":[{"name":"昵称","impression":"一句话印象"}]}',
    '',
    '群聊记录：',
    transcript,
  ].join('\n');
}

/**
 * 从模型的回答里抠出 people 数组，并洗干净。
 * @param {string} reply
 * @returns {Array<{ name: string, impression: string }>}
 */
export function parseImpressionReply(reply) {
  const parsed = parseJsonReply(reply) ?? {};
  const raw = Array.isArray(parsed.people) ? parsed.people : [];
  const out = [];
  for (const p of raw.slice(0, MAX_PEOPLE_PER_RUN)) {
    const name = String(p?.name ?? '').trim();
    const impression = cleanImpression(p?.impression);
    if (!name || !impression) continue;
    // 防幻觉：印象里出现"不知道/无法判断"这类，说明没素材，丢掉
    if (/^(不知道|无法判断|看不出来|没有信息)/.test(impression)) continue;
    out.push({ name, impression });
  }
  return out;
}

/**
 * 造一个"提炼器"：给流水，返回印象更新。
 *
 * @param {{ agents?: { runOnce?: Function }, trace?: (e: string, d: any) => void }} deps
 * @param {{ renderTranscript?: Function, buildPrompt?: Function, parseReply?: Function }} [helpers]
 */
export function createImpressionDistiller(deps, helpers = {}) {
  const render = helpers.renderTranscript ?? renderTranscript;
  const build = helpers.buildPrompt ?? buildImpressionPrompt;
  const parse = helpers.parseReply ?? parseImpressionReply;

  return {
    /**
     * @param {{ names: string[], records: any[], currentMemory?: string, transcriptLimit?: number }} input
     */
    async distill(input) {
      const names = (input?.names ?? []).filter(Boolean).slice(0, MAX_PEOPLE_PER_RUN);
      if (names.length === 0) return [];
      const limit = input?.transcriptLimit ?? TRANSCRIPT_LIMIT;
      const records = (input?.records ?? []).slice(-limit);
      const transcript = render(records);
      if (!transcript.trim()) return [];

      const prompt = build(names, transcript, input?.currentMemory ?? '');
      const runner = deps.agents;
      if (!runner?.runOnce) throw new Error('子代理尚未就绪');
      const out = await runner.runOnce('群友印象', prompt, 60000);
      if (!out) return [];
      const people = parse(out);
      deps.trace?.('impression-distill', {
        asked: names,
        got: people.map((p) => p.name),
        count: people.length,
      });
      return people;
    },
  };
}
