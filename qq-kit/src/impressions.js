/**
 * 群友印象的自动更新。
 *
 * 问题：群记忆里的「群里的人」是手写的，写了就烂在那儿 ——
 * 新人来了不记，老人脾气变了不更新，几个月后那一段全是过时的印象。
 *
 * 做法：每隔一段时间，让总结子代理从**最近的聊天流水**里提炼"这些人现在什么样"，
 * 合并进群记忆的人名条目。守几条线：
 *
 *   1. **只动「群里的人」那一段** —— 权限规则、亲密关系、我是谁这些一个字都不碰；
 *   2. **有就改，没有就加** —— 已认识的人更新印象，新人补一条；
 *   3. **印象有长度上限** —— 别让一句话变成一段小传，把 prompt 撑爆；
 *   4. **写之前备份** —— 出问题能回滚；
 *   5. **失败了不影响收发** —— 更新记忆是锦上添花，不是主链路。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 单人印象的最大长度（字）。超过就截断，别让一条记忆吃掉半屏 prompt。 */
// 印象要短。它是每轮都进 prompt 的东西——写 60 字，二十个人就是 1200 字，
// 全是钱。30 字够说清一个人是什么样，多的都是废话。
export const IMPRESSION_MAX = 30;

/** 一次最多更新几个人。太多会稀释质量。 */
export const MAX_PEOPLE_PER_RUN = 6;

/** 备份目录名（放在记忆目录下） */
const BACKUP_DIR = '.impressions-backup';

/**
 * 从群记忆里捞出「群里的人」那一段的起止行号。
 *
 * 结构约定：
 *   ## 群里的人
 *   > 说明行（可选）
 *   - **昵称（QQ xxx）**：印象
 *   ...
 *   ## 下一节
 *
 * @param {string} memory
 * @returns {{ start: number, end: number, headerIndex: number } | null}
 */
export function locatePeopleSection(memory) {
  const lines = String(memory ?? '').split(/\r?\n/);
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s*群里的人\s*$/.test(lines[i].trim())) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) return null;
  // 下一节标题（## 开头）或文件结尾
  let end = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start: headerIndex, end, headerIndex };
}

/**
 * 把「群里的人」那一段拆成结构化条目。
 * @param {string} memory
 * @returns {Array<{ line: number, name: string, id: string, raw: string }>}
 */
export function parsePeopleSection(memory) {
  const lines = String(memory ?? '').split(/\r?\n/);
  const range = locatePeopleSection(memory);
  if (!range) return [];
  const out = [];
  for (let i = range.headerIndex + 1; i < range.end; i += 1) {
    const line = lines[i];
    const m = line.match(/^\s*[-*]\s+\*\*(.+?)\*\*/);
    if (!m) continue;
    const head = m[1];
    const name = head.replace(/[（(][^）)]*[）)]/g, '').replace(/`/g, '').trim();
    out.push({ line: i, name, id: extractId(line), raw: line });
  }
  return out;
}

/**
 * 从一行里取出这个人的号。
 *
 * 优先级很重要 —— 踩过的坑：以前直接 `line.match(/\d{5,}/g)` 扫全行，
 * 于是 `（`2729BB896205BA354B077BB70DD7679A`）` 这种 openid 里的
 * 中间一段 `896205` 会被当成 QQ 号，面板上就多出一个查无此人的节点。
 *
 * 正确顺序：
 *   ① 括号里明确写的 QQ 号       （QQ 123456）/ (123456)
 *   ② 完整的 32 位 openid        （`ABCD...`）
 *   ③ 实在没有，才退回去扫行里的裸数字
 *
 * @param {string} line
 * @returns {string}
 */
export function extractId(line) {
  const text = String(line ?? '');

  // ① 括号里的 QQ 号：先剥掉 openid（它也是括号内容，容易混）
  const withoutHex = text.replace(/[0-9A-Fa-f]{32}/g, '');
  const qq = withoutHex.match(/[（(]\s*(?:QQ|qq)?\s*[:：]?\s*(-?\d{5,})\s*[)）]/);
  if (qq) return qq[1].replace(/^-/, '');

  // ② 完整的 32 位 openid
  const hex = text.match(/[0-9A-Fa-f]{32}/)?.[0] ?? '';
  if (hex) return hex;

  // ③ 兜底：行里的裸数字（但没有括号的暗示，只能算勉强）
  const bare = text.match(/\d{5,}/g) ?? [];
  return bare[0] ?? '';
}

/**
 * 把一段自由文本压成一行印象：去换行、去引号、限长。
 * @param {unknown} raw
 * @returns {string}
 */
export function cleanImpression(raw) {
  const text = String(raw ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^[\s「『"'（(]+|[\s」』"'）)]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, IMPRESSION_MAX);
}

/**
 * 把更新合并进群记忆。
 *
 * 只改「群里的人」段里的列表行：
 *   - 已存在（按名字对）→ 替换冒号后面的印象
 *   - 不存在 → 插在列表末尾
 * 段外内容原样保留。
 *
 * @param {string} memory 原记忆全文
 * @param {Array<{ name: string, impression: string, id?: string }>} updates 要更新的印象
 * @returns {string} 新记忆全文
 */
export function mergeImpressions(memory, updates) {
  const text = String(memory ?? '');
  const list = (updates ?? []).slice(0, MAX_PEOPLE_PER_RUN);
  if (list.length === 0) return text;

  const range = locatePeopleSection(text);
  if (!range) return text; // 没有这一节就不冒险加，交给人工
  const lines = text.split(/\r?\n/);
  const existing = parsePeopleSection(text);

  // 同一个人在同一轮里只处理一次：后出现的覆盖先出现的。
  // 做法是先按名字（小写）去重，保留最后一条。
  const byName = new Map();
  for (const u of list) {
    const name = String(u?.name ?? '').trim();
    if (name) byName.set(name.toLowerCase(), u);
  }

  let added = 0;
  for (const u of byName.values()) {
    const name = String(u?.name ?? '').trim();
    const impression = cleanImpression(u?.impression);
    const wantId = String(u?.id ?? '').trim();
    if (!name || !impression) continue;

    // 匹配优先级：号 > 名字。
    //
    // 为什么号优先：真实记忆里同一个昵称可能挂着两条不同 id 的条目
    // （老档案 openid 版 + 新档案 QQ 号版），只按名字找会改错那条。
    // 号对不上的时候才退回按名字找 —— 模型有时只给昵称，没给号。
    let hit = null;
    if (wantId) hit = existing.find((e) => e.id && e.id === wantId);
    if (!hit) hit = existing.find((e) => e.name.toLowerCase() === name.toLowerCase());

    if (hit) {
      // 保留原来的 **昵称（号）** 头部，只换后面那句
      const head = (hit.raw.match(/^\s*[-*]\s+\*\*.*?\*\*/) ?? [''])[0];
      if (!head) continue;
      lines[hit.line] = `${head}：${impression}`;
    } else {
      // 新人：别猜号，没号就只写名字
      const head = wantId ? `- **${name}（QQ ${wantId}）**` : `- **${name}**`;
      lines.splice(range.end + added, 0, `${head}：${impression}`);
      added += 1;
    }
  }
  return lines.join('\n');
}

/**
 * 判断某个人在群记忆里是否已经有条目。
 *
 * 按号优先，号对不上再看名字 —— 和 mergeImpressions 同一套规则。
 *
 * @param {string} memory
 * @param {{ name: string, id: string }} who
 * @returns {boolean}
 */
export function hasPersonEntry(memory, who) {
  const name = String(who?.name ?? '').trim().toLowerCase();
  const id = String(who?.id ?? '').trim();
  if (!name && !id) return false;
  return parsePeopleSection(memory).some((e) => {
    if (id && e.id && e.id === id) return true;
    return name && e.name.toLowerCase() === name;
  });
}

/**
 * 给"第一次见到的人"建档：只写名字和号，印象留空待补。
 *
 * 为什么要实时建：批量更新是 6 小时一次，新人进群当天可能一直没档案，
 * 认不出人、关系判成 stranger、回话也生硬。先建档，印象后面慢慢补。
 *
 * @param {string} memory
 * @param {{ name: string, id: string, note?: string }} who
 * @param {number} [maxEntries] 这一段最多留多少条（超了不再加，靠人工清理）
 * @returns {{ memory: string, added: boolean }}
 */
export function addPersonEntry(memory, who, maxEntries = 40) {
  const text = String(memory ?? '');
  const name = String(who?.name ?? '').trim();
  const id = String(who?.id ?? '').trim();
  if (!name || !id) return { memory: text, added: false };

  const range = locatePeopleSection(text);
  if (!range) return { memory: text, added: false };
  if (hasPersonEntry(text, { name, id })) return { memory: text, added: false };

  const existing = parsePeopleSection(text);
  if (existing.length >= maxEntries) return { memory: text, added: false };

  // 纯数字当昵称多半是没拿到群名片（协议端只给了号），写括号里那部分就行
  const display = /^\d+$/.test(name) ? `群友${name.slice(-4)}` : name;
  const note = cleanImpression(who?.note) || '刚进群的，还没摸清脾气';
  const entry = `- **${display}（QQ ${id}）**：${note}`;

  const lines = text.split(/\r?\n/);
  lines.splice(range.end, 0, entry);
  return { memory: lines.join('\n'), added: true };
}

/**
 * 把记忆文件写到磁盘，写之前备份。
 *
 * @param {string} file
 * @param {string} content
 * @returns {{ backup: string }}
 */
export function writeMemoryFile(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // 备份：带时间戳，放子目录，别把记忆目录搞乱
  const backupDir = path.join(dir, BACKUP_DIR);
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(backupDir, `${path.basename(file, '.md')}-${stamp}.md`);
  try {
    fs.copyFileSync(file, backup);
  } catch {
    // 文件不存在（第一次建）就没得备份，不算错
  }
  // 原子写：先写临时文件再 rename，写一半崩了不会毁掉原文件
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
  return { backup };
}

/**
 * 从聊天流水里挑出"值得更新印象"的人：说得多的优先。
 *
 * @param {Array<{ sender?: string, senderId?: string }>} records 历史流水（historyLog 那种）
 * @param {number} [limit]
 * @returns {Array<{ name: string, id: string, count: number }>}
 */
export function pickPeopleToUpdate(records, limit = MAX_PEOPLE_PER_RUN) {
  /** @type {Map<string, { name: string, id: string, count: number }>} */
  const byId = new Map();
  for (const r of records ?? []) {
    const id = String(r?.senderId ?? '').trim();
    const name = String(r?.sender ?? '').trim();
    if (!id || !name) continue;
    const cur = byId.get(id);
    if (cur) cur.count += 1;
    else byId.set(id, { name, id, count: 1 });
  }
  return [...byId.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}
