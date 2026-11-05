/**
 * 群友改名同步。
 *
 * 问题：记忆里的昵称是建档时抄下来的，之后别人改了群名片，档案里还是老名字。
 * 结果就是面板上挂着一个人早就换掉的旧名字，看着像另一个人。
 *
 * 做法：靠消息里的 QQ 号当主键，把群记忆里那条的**名字**换成最新的群名片，
 * 后面的印象一个字不动 —— 认人从来靠号，名字只是给人看的。
 *
 * 边界：
 *   - 只改「群里的人」那一节
 *   - 只改 **名字** 部分，括号里的号、冒号后面的印象都不碰
 *   - 纯数字名不改（那是没拿到群名片的占位，等真名来了再换）
 *   - 写盘走备份 + 原子写，跟其他记忆改动一致
 */
import fs from 'node:fs';
import path from 'node:path';

import { locatePeopleSection } from './impressions.js';

/** 一个人多久检查一次改名（毫秒）。太频繁没必要，名字不会每分钟变。 */
export const RENAME_CHECK_MS = 6 * 60 * 60 * 1000;

/**
 * 从一行人名条目里拆出「头部」和「描述」。
 *
 *   - **老王（QQ 100000001）**：话多
 *   → head: `- **老王（QQ 100000001）**`  body: `话多`
 *
 * @param {string} line
 * @returns {{ head: string, body: string } | null}
 */
export function splitEntry(line) {
  // 两种头部写法都要认：
  //   - **老王（QQ 100000001）**：话多        ← 号在**里面**
  //   - **某甲**（`BBBBBB...`）：技术好       ← 号在**外面**
  //
  // 第二种的 `**` 就在名字后面，所以不能简单地"取最后一个 **" ——
  // 要按行首的 `- **` 找到开，再找后面第一个收得回来的 `**`。
  const m = String(line ?? '').match(/^(\s*[-*]\s+\*\*[\s\S]*?\*\*(?:\s*[（(][^）)]*[）)])?)\s*[：:]?\s*([\s\S]*)$/);
  if (!m) return null;
  return { head: m[1], body: m[2] };
}

/**
 * 从头部里取出昵称（去掉括号里的号）。
 * @param {string} head
 */
export function nameOfHead(head) {
  const m = String(head ?? '').match(/\*\*(.+?)\*\*/);
  if (!m) return '';
  return m[1].replace(/[（(][^）)]*[）)]/g, '').replace(/`/g, '').trim();
}

/**
 * 把一行的名字换成新名字，其余原样保留。
 *
 * 号保持不动 —— 那是认人的依据。括号形式也沿用原来的（原来用**（QQ 123）**
 * 就还是**（QQ 123）**，原来用 `openid` 就还是那个）。
 *
 * @param {string} line
 * @param {string} newName
 * @returns {string} 改不了就原样返回
 */
export function renameEntry(line, newName) {
  const parts = splitEntry(line);
  if (!parts) return line;
  const name = String(newName ?? '').trim();
  if (!name) return line;
  // 纯数字名当占位，不让它覆盖已有的真名；反过来，新名字是纯数字也不采用
  if (/^\d+$/.test(name)) return line;

  const oldHead = parts.head;
  // 头部两种形态都要照顾：
  //   A)  - **老王（QQ 100000001）**     ← 号在星号里面，名字要重写、括号留着
  //   B)  - **某甲**（`ABCD...`）        ← 号在星号外面，只换星号里的名字
  const a = oldHead.match(/^(\s*[-*]\s+)\*\*([\s\S]*)\*\*\s*$/);
  const b = oldHead.match(/^(\s*[-*]\s+)\*\*([\s\S]*?)\*\*\s*([（(][\s\S]*[）)])\s*$/);

  // B 优先判断：「名字」后面紧跟括号的，括号不属于名字
  if (b) {
    const [, lead, inner, bracket] = b;
    const namePart = inner.replace(/`/g, '').trim();
    if (namePart === name) return line;
    return `${lead}**${name}**${bracket}${parts.body ? '：' + parts.body : ''}`;
  }

  if (a) {
    const [, lead, inner] = a;
    // inner = `老王（QQ 100000001）` → 名字部分 + 尾巴（括号那截）
    const namePart = inner.replace(/[（(][^）)]*[）)]/g, '').replace(/`/g, '').trim();
    const tailStart = inner.indexOf('（') >= 0 ? inner.indexOf('（') : inner.indexOf('(');
    const tail = tailStart >= 0 ? inner.slice(tailStart) : '';
    if (namePart === name) return line;
    return `${lead}**${name}${tail}**${parts.body ? '：' + parts.body : ''}`;
  }

  return line;
}

/**
 * 在整份群记忆里找到某个号对应的那一行并改名。
 *
 * @param {string} memory
 * @param {string} userId
 * @param {string} newName
 * @returns {{ memory: string, changed: boolean, oldName: string }}
 */
export function renameInMemory(memory, userId, newName) {
  const text = String(memory ?? '');
  const uid = String(userId ?? '').trim();
  if (!text || !uid) return { memory: text, changed: false, oldName: '' };

  const range = locatePeopleSection(text);
  if (!range) return { memory: text, changed: false, oldName: '' };

  const lines = text.split(/\r?\n/);
  // 从后往前改：万一同一个号有多条（理论上不该有），都改成新名字
  for (let i = range.end - 1; i > range.headerIndex; i -= 1) {
    const line = lines[i];
    if (!/^\s*[-*]\s+\*\*/.test(line)) continue;
    // 号必须在这一行里（按 extractId 的口径，但这里用更宽的匹配 ——
    // 反正只在「群里的人」这一段里找，误伤面很小）
    const hex = line.match(/[0-9A-Fa-f]{32}/)?.[0] ?? '';
    const qq = line.match(/[（(]\s*(?:QQ\s*)?(\d{5,})\s*[)）]/)?.[1] ?? '';
    const hit = uid === hex || uid === qq;
    if (!hit) continue;
    const oldName = nameOfHead(line);
    const next = renameEntry(line, newName);
    if (next !== line) lines[i] = next;
  }

  const nextMemory = lines.join('\n');
  return {
    memory: nextMemory,
    changed: nextMemory !== text,
    oldName: '',
  };
}

/**
 * 写回记忆文件：备份 + 原子写。
 *
 * @param {string} file
 * @param {string} content
 * @returns {{ backup: string | null }}
 */
export function writeMemorySafely(file, content) {
  const dir = path.dirname(file);
  let backup = null;
  if (fs.existsSync(file)) {
    const bdir = path.join(dir, '.rename-backup');
    fs.mkdirSync(bdir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = path.join(bdir, `${path.basename(file, '.md')}-${stamp}.md`);
    fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
  return { backup };
}
