/**
 * 记忆：让回答"记得住人、记得住事"。
 *
 * 三层（本文件管前两层，第三层靠持久化摘要）：
 *   1. 群记忆文件（<memoryDir>/<群号>.md）—— 谁是谁、什么脾气、聊过什么；
 *   2. 已知用户表（known-users.json）—— 兜底的昵称映射；
 *   3. 会话摘要（由 storage.js 落盘，重启不丢）。
 *
 * 设计原则：读不到就当没有，绝不让插件起不来。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 读群记忆文件。
 * @param {{ memoryDir?: string, chatId: string, warn?: (m: string) => void }} options
 * @returns {string} 空串表示没有
 */
export function loadGroupMemory(options) {
  const { memoryDir, chatId, warn } = options;
  if (!memoryDir) return '';
  const file = path.join(memoryDir, `${chatId}.md`);
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text;
  } catch (error) {
    // 没有这个群的记忆是正常情况，不吵
    if (error && typeof error === 'object' && error.code === 'ENOENT') return '';
    warn?.(`读取群记忆失败（${file}）：${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

/**
 * 读 known-users.json，返回可以塞进 prompt 的简短名单。
 * 只取有昵称的条目；openid 太长，只保留后 6 位便于对号。
 * @param {{ path?: string, warn?: (m: string) => void }} [options]
 * @returns {string}
 */
export function loadKnownUsers(options = {}) {
  if (!options.path) return '';
  try {
    const raw = JSON.parse(fs.readFileSync(options.path, 'utf8'));
    if (!Array.isArray(raw)) return '';
    const lines = raw
      .filter((u) => u && typeof u === 'object' && u.nickname)
      .map((u) => {
        const id = String(u.openid ?? '').slice(-6);
        const kind = u.type === 'group' ? '群' : '私聊';
        return `- ${kind}「${u.nickname}」（…${id}）`;
      });
    return lines.join('\n');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return '';
    options.warn?.(`读取 known-users 失败：${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

/**
 * 判断某个 id 在群记忆里是不是"自己人"（主人 / 管理员 / 熟人）。
 *
 * 做法：找这个人的人名条目和提到他的规则段，看有没有亲密度关键词。
 * 没写在记忆里的陌生人一律返回 'stranger'。
 *
 * 为什么不用模型判：这层要的是稳定，模型每轮判读会漂；
 * 记忆里写着的"主人""管这摊事"就是最硬的信号。
 *
 * @param {string} memory 群记忆 markdown
 * @param {string} userId 发消息的人
 * @returns {'owner'|'admin'|'friend'|'stranger'}
 */
export function relationshipOf(memory, userId) {
  const uid = String(userId ?? '').trim();
  if (!uid) return 'stranger';
  const lines = String(memory ?? '').split(/\r?\n/);
  const isPersonLine = (line) => /^\s*[-*]\s+\*\*/.test(line);
  // 号可能是 QQ 数字号，也可能是老档案里的 32 位 openid —— 两种都认
  const idSet = (line) => {
    const ids = new Set(line.match(/\d{5,}/g) ?? []);
    const hex = line.match(/[0-9A-Fa-f]{32}/g) ?? [];
    for (const h of hex) ids.add(h);
    return ids;
  };
  // name:<名字> 形式：早期档案只记名字没记号，按名字对
  const isNameKey = uid.startsWith('name:');
  const nameKey = isNameKey ? uid.slice(5) : '';
  const hasId = (line) => {
    if (!isNameKey) return idSet(line).has(uid);
    const m = line.match(/^\s*[-*]\s+\*\*(.+?)\*\*/);
    if (!m) return false;
    const nm = m[1].replace(/[（(][^）)]*[）)]/g, '').replace(/`/g, '').trim().toLowerCase();
    return nm === nameKey;
  };

  // 人名条目 + 明确点了这个号的其他说明段，一起当证据
  const evidence = lines.filter((line) => hasId(line)).join('\n');
  if (!evidence) return 'stranger';

  if (/主人|owner/i.test(evidence)) return 'owner';
  if (/管理员|群管|admin/i.test(evidence)) return 'admin';
  // 记忆里写了这个人"什么样"（有具体人名条目），就算认识的人：
  // 知道他的脾气和聊法，拌嘴才有分寸。真陌生人连条目都不会有。
  if (lines.some((line) => isPersonLine(line) && hasId(line))) return 'friend';
  return 'stranger';
}

/**
 * 关系 → 给模型看的一句态度提示。
 * @param {'owner'|'admin'|'friend'|'stranger'} rel
 * @returns {string}
 */
export function relationshipHint(rel) {
  switch (rel) {
    case 'owner':
      // 主人是"亲近度拉满"的那个：不只是服从，还有暖意
      return '这个人是你的主人，也是你最亲的人：他说的话优先，但语气要软——愿意贴过去、被说两句也不记仇、他夸一句能高兴半天。别冷着，也别端着。';
    case 'admin':
      return '这个人是群管理员：别跟他抬杠，他让你停就停。';
    case 'friend':
      return '这个人跟你熟：可以损、可以接梗，拌嘴当玩。';
    default:
      return '这个人你不熟：客气一点、话短一点，别上来就损。';
  }
}

/**
 * 只保留群记忆里"最近说过话的人"的条目，压缩 prompt 体积。
 *
 * 为什么：整份群档案会随群人数膨胀（几百人就是几十 KB），每轮全带太浪费。
 * 认人只需要当前在场的几个；其余人只补少量"最近活跃"的做兜底。
 * 一个都匹配不上（比如全新面孔）才原样返回，避免记忆被清空。
 *
 * @param {string} memory 群记忆 markdown
 * @param {string[]} activeIds 本批发言人的 QQ 号
 * @param {{ maxOthers?: number }} [options] 额外补多少个非当前说话人的人名条目
 * @returns {string}
 */
export function trimGroupMemory(memory, activeIds, options = {}) {
  const text = String(memory ?? '');
  if (!text || !Array.isArray(activeIds) || activeIds.length === 0) return text;
  const ids = new Set(activeIds.map(String).filter(Boolean));
  if (ids.size === 0) return text;

  const lines = text.split(/\r?\n/);
  const isPersonLine = (line) => /^\s*[-*]\s+\*\*/.test(line);
  const numsOf = (line) => line.match(/\d{5,}/g) ?? [];

  const kept = [];
  const others = [];
  let matched = 0;
  for (const line of lines) {
    if (!isPersonLine(line)) {
      kept.push(line);
      continue;
    }
    if (numsOf(line).some((n) => ids.has(n))) {
      kept.push(line);
      matched += 1;
    } else {
      others.push(line);
    }
  }
  // 一个都对不上：原样返回，别把记忆清空
  if (matched === 0) return text;

  const maxOthers = options.maxOthers ?? 3;
  const tail = others.slice(0, Math.max(0, maxOthers));
  return [...kept, ...tail].join('\n');
}

/**
 * 把记忆拼成 prompt 里的一个区块。
 * @param {{ groupMemory?: string, knownUsers?: string }} parts
 * @returns {string} 空串表示没有可用记忆
 */
export function renderMemoryBlock(parts) {
  const blocks = [];
  if (parts.groupMemory) blocks.push(`【这个群的记忆】\n${parts.groupMemory}`);
  if (parts.knownUsers) blocks.push(`【认识的人】\n${parts.knownUsers}`);
  return blocks.join('\n\n');
}
