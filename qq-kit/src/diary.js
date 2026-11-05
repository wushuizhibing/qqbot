/**
 * 个人日记：按 QQ 号归档"关键事件"。
 *
 * 跟"群友印象"是两件事：
 *   印象 —— 这个人是什么样（性格、习惯），短，长期稳定
 *   日记 —— 这个人身上发生过什么（要求、冲突、约定），具体，按时间排
 *
 * 为什么要 QQ 号做主键：
 *   群里人常改昵称。名字只是显示用的，认人必须靠号，
 *   否则"老王"改名叫"大王"就变成两个人了。
 *
 * 只记关键事件，不记流水：
 *   ✅ 对它有要求的（让我改、让我停、让我做什么）
 *   ✅ 有情绪冲突或转折的（被骂、被夸、道歉、和解）
 *   ✅ 有承诺或约定的（说好明天开黑）
 *   ❌ 纯闲聊、表情包、附和
 *
 * 落盘结构：
 *   <root>/<群号>/<QQ号>.md
 */
import fs from 'node:fs';
import path from 'node:path';

/** 单个日记文件最多留多少条事件（超了从最旧的删） */
export const DIARY_MAX_EVENTS = 300;
/** 一次最多处理几个人 */
export const MAX_PEOPLE_PER_RUN = 8;
/** 转写里放多少条消息 */
export const TRANSCRIPT_LIMIT = 120;
/** 单条事件的字数上限 */
export const EVENT_MAX_CHARS = 60;
/** 备份目录名 */
const BACKUP_DIR = '.diary-backup';

/**
 * 日记文件路径。
 *
 * 号里可能有非法文件名（openid 就没事），统一只留 [A-Za-z0-9_-]。
 *
 * @param {string} root
 * @param {string} groupId
 * @param {string} userId
 * @returns {string}
 */
export function diaryPath(root, groupId, userId) {
  const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'unknown';
  return path.join(root, safe(groupId), `${safe(userId)}.md`);
}

/**
 * 把时间戳格式化成 `MM-DD HH:mm`。
 * @param {number} at
 */
export function formatStamp(at) {
  const d = new Date(Number(at) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 解析已有日记，拿到标题行和事件列表。
 * @param {string} text
 * @returns {{ name: string, userId: string, intro: string, events: Array<{at: number, text: string}> }}
 */
export function parseDiary(text) {
  const raw = String(text ?? '');
  const lines = raw.split(/\r?\n/);

  // 标题形如： # 昵称（QQ 123456）
  const titleLine = lines.find((l) => /^#\s+/.test(l)) ?? '';
  const m = titleLine.match(/^#\s+(.+?)[（(]QQ\s+([^）)]+)[）)]/);
  const name = m ? m[1].trim() : '';
  const userId = m ? m[2].trim() : '';

  // 事件行： - MM-DD HH:mm 内容
  const events = [];
  for (const line of lines) {
    const e = line.match(/^\s*[-*]\s+(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s+(.+)$/);
    if (!e) continue;
    const [, mo, da, hh, mi, rest] = e;
    const now = new Date();
    let year = now.getFullYear();
    // 跨年：日记里只有月日，如果解析出来的时间比现在还晚一个月以上，
    // 说明是去年的（12 月写的，现在 1 月读）
    const probe = new Date(year, Number(mo) - 1, Number(da), Number(hh), Number(mi));
    if (probe.getTime() - now.getTime() > 31 * 24 * 3600 * 1000) year -= 1;
    events.push({
      at: new Date(year, Number(mo) - 1, Number(da), Number(hh), Number(mi)).getTime(),
      text: rest.trim(),
    });
  }

  // 「## 关于他」那节的引言：没有就空
  const introMatch = raw.match(/##\s*关于他\s*\n([\s\S]*?)(?:\n##\s|\n*$)/);
  const intro = introMatch ? introMatch[1].trim() : '';

  return { name, userId, intro, events };
}

/**
 * 把日记渲染回 markdown。
 *
 * @param {{ name: string, userId: string, intro?: string, events: Array<{at: number, text: string}> }} diary
 * @returns {string}
 */
export function renderDiary(diary) {
  const name = String(diary?.name ?? '').trim() || '未知';
  const userId = String(diary?.userId ?? '').trim();
  const events = [...(diary?.events ?? [])].sort((a, b) => a.at - b.at);
  // 只留最近 N 条
  const kept = events.slice(-DIARY_MAX_EVENTS);

  const out = [`# ${name}（QQ ${userId}）`, ''];
  const intro = String(diary?.intro ?? '').trim();
  if (intro) out.push('## 关于他', '', intro, '');

  out.push('## 事件', '');
  if (kept.length === 0) out.push('（还没有记下什么）');
  else for (const e of kept) out.push(`- ${formatStamp(e.at)} ${e.text}`);

  return out.join('\n') + '\n';
}

/**
 * 把新事件并进已有日记（按时间排序、去重、截断）。
 *
 * 去重判据：同一分钟内、内容高度相似就算重复 —— 定时任务跑两遍不会记两遍。
 *
 * @param {{ name: string, userId: string, intro?: string, events?: Array<{at:number,text:string}> }} old
 * @param {Array<{ at: number, text: string }>} fresh
 * @param {{ name?: string }} [meta]
 */
export function mergeDiary(old, fresh, meta = {}) {
  const name = String(meta.name ?? old?.name ?? '').trim();
  const userId = String(old?.userId ?? '').trim();
  const events = [...(old?.events ?? [])];

  const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
  for (const e of fresh ?? []) {
    const text = String(e?.text ?? '').trim();
    if (!text) continue;
    const at = Number(e?.at) || Date.now();
    // 1 分钟内 + 去掉空白后相同 → 视为重复
    const dup = events.some(
      (x) => Math.abs(x.at - at) < 60_000 && norm(x.text) === norm(text),
    );
    if (dup) continue;
    events.push({ at, text: text.slice(0, EVENT_MAX_CHARS) });
  }

  return {
    name,
    userId,
    intro: String(old?.intro ?? '').trim(),
    events,
  };
}

/**
 * 写日记文件（备份 + 原子写）。
 *
 * @param {string} file
 * @param {string} content
 * @returns {{ backup: string|null }}
 */
export function writeDiaryFile(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  let backup = null;
  if (fs.existsSync(file)) {
    const bdir = path.join(dir, BACKUP_DIR);
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

/**
 * 挑出这次要更新日记的人。
 *
 * 优先最近说过话的；同一批里按消息条数排。
 *
 * @param {Array<{ id?: string, name?: string }>} records
 * @param {number} [limit]
 */
export function pickPeopleForDiary(records, limit = MAX_PEOPLE_PER_RUN) {
  const counts = new Map();
  for (const r of records ?? []) {
    const id = String(r?.id ?? '').trim();
    const name = String(r?.name ?? '').trim();
    if (!id || !name) continue;
    const prev = counts.get(id) ?? { id, name, count: 0 };
    prev.count += 1;
    prev.name = name; // 用最新的昵称
    counts.set(id, prev);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(0, limit));
}
