/**
 * 关系判断：从群记忆文本里看出某个 id 是"什么人"。
 *
 * 这是人物星系的数据基础 —— 只要聊天插件把"群记忆"（谁是谁、什么脾气）
 * 以文本形式暴露出来，这里就能判断关系并算亲近度。
 */

/** @typedef {'owner'|'admin'|'friend'|'stranger'} Relation */

/** 关系强弱排序：合并同一人时取更强的那个。 */
export const REL_RANK = { stranger: 0, friend: 1, admin: 2, owner: 3 };

/**
 * @param {Relation|string} rel
 * @returns {number}
 */
export function relationRank(rel) {
  return REL_RANK[rel] ?? 0;
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
 * @param {string} userId 发消息的人（QQ 号 / openid / `name:名字`）
 * @returns {Relation}
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
 * @param {Relation} rel
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
