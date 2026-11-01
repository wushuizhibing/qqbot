/**
 * 人格加载：把 soul.md 读进来，作为子代理的系统提示前缀。
 *
 * 为什么不整篇塞：soul.md 有 15KB（17 节），每轮都当 prompt 会明显放大 token。
 * 做法是分两档：
 *   - core：临场反应 + 你是谁 + 说话铁律 + AI 味黑名单 + 回复示例（约 5-6KB），每轮都带
 *   - full：整篇，只在 scene 需要时（或配置要求"全文"）才用
 * 文件读不到时退回内置的精简版，不会让插件起不来。
 */
import fs from 'node:fs';

/** 这些章节标题（前缀匹配）归到 core。 */
const CORE_SECTIONS = [
  '## 临场反应',
  '## 一、你是谁',
  '## 二、群聊说话铁律',
  '## 十、AI 味黑名单',
  '## 十一、回复示例',
];

/** 文件读不到时的兜底人格：只保留最关键的行为约束。 */
export const FALLBACK_PERSONA = `你是一个群聊机器人，身份是群友，不是助手。
说人话：默认一句话 1~10 字，能用"？""6""草""乐"回的，就别写成一段。
不总结、不升华、不给建议、不用客服腔（"很高兴为您服务""希望对您有帮助"）。
被 @ 或被点名就回；被骂被阴阳就直接不回。
不想说话就只输出 NO_REPLY。`;

/**
 * 按章节切分 markdown（只认二级标题）。
 * @param {string} text
 * @returns {Array<{heading: string, body: string}>}
 */
export function splitSections(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  /** @type {Array<{heading: string, body: string}>} */
  const out = [];
  let current = { heading: '', body: '' };
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (current.heading || current.body.trim()) out.push(current);
      current = { heading: line.trim(), body: `${line}\n` };
    } else {
      current.body += `${line}\n`;
    }
  }
  if (current.heading || current.body.trim()) out.push(current);
  return out;
}

/**
 * 从整篇 soul.md 里抽出 core 人格。
 * @param {string} text
 * @returns {string}
 */
export function extractCorePersona(text) {
  const sections = splitSections(text);
  const picked = sections.filter((s) => CORE_SECTIONS.some((head) => s.heading.startsWith(head)));
  if (picked.length === 0) return String(text ?? '').trim();
  return picked.map((s) => s.body.trim()).join('\n\n');
}

/**
 * 加载人格。
 * @param {{ path?: string, mode?: 'core'|'full', warn?: (msg: string) => void }} [options]
 * @returns {{ text: string, source: string, mode: 'core'|'full'|'fallback', bytes: number }}
 */
export function loadPersona(options = {}) {
  const mode = options.mode === 'full' ? 'full' : 'core';
  const file = options.path;
  if (!file) return { text: FALLBACK_PERSONA, source: '(内置)', mode: 'fallback', bytes: Buffer.byteLength(FALLBACK_PERSONA) };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const text = mode === 'full' ? raw.trim() : extractCorePersona(raw);
    if (!text) throw new Error('文件是空的');
    return { text, source: file, mode, bytes: Buffer.byteLength(text) };
  } catch (error) {
    options.warn?.(`读取人格文件失败（${file}）：${error instanceof Error ? error.message : String(error)}`);
    return { text: FALLBACK_PERSONA, source: '(内置)', mode: 'fallback', bytes: Buffer.byteLength(FALLBACK_PERSONA) };
  }
}
