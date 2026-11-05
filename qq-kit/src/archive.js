/**
 * QQ 会话归档。
 *
 * 背景：qq-kit 每轮对话都会让 DSH 建一个 agent 会话，所以 profile 目录里
 * 堆了六千多个 session-*，看着乱、也占地方。
 *
 * 关键发现：这些会话文件**只有元信息、没有对话内容** ——
 * 真正聊了什么在 history-*.jsonl 里（那是我们自己的日志）。
 * 所以归档它们是零损失的，不需要"先提炼再删"。
 *
 * 判断依据是会话文件第一行里的 agentPreset：
 *   'qq-kit-chat'  → 这是 QQ 聊天会话，归我们管
 *   其它（standard 等）→ 用户自己的会话，绝不碰
 *
 * 做法：超过 N 天没改动的、且确认是空壳的，整个目录**移动**到
 * sessions-backup/qq-archive-<日期>/ 下。移动不是删除，随时能挪回来。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** 只认这个 preset，别的会话一律不动 */
const QQ_PRESET = 'qq-kit-chat';

/** 会话文件名 */
const SESSION_FILE = 'session.v4.jsonl.zstd';

/**
 * 读一个会话文件的元信息 + 正文行数。
 * 读不出来（损坏/格式变了）就返回 null —— 那种情况我们一律跳过，不乱动。
 *
 * @param {string} file
 * @returns {{ preset: string, bodyLines: number } | null}
 */
function readSessionMeta(file) {
  try {
    const raw = fs.readFileSync(file);
    const text = zlib.zstdDecompressSync(raw).toString('utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    if (!lines.length) return null;
    const first = JSON.parse(lines[0]);
    return {
      preset: String(first.agentPreset ?? ''),
      // 去掉元信息那一行之后还剩几行 —— 有正文就不是空壳
      bodyLines: lines.length - 1,
    };
  } catch {
    return null;
  }
}

/**
 * 扫一遍 profile 的 sessions 目录，挑出可以归档的会话。
 *
 * @param {{
 *   sessionsRoot: string,       扫描的根（各个 --cwd-- 目录的上一层）
 *   keepDays?: number,          多久没动才算旧
 *   now?: number,
 *   onlyEmpty?: boolean,        只归档空壳（默认 true）
 * }} options
 * @returns {{
 *   candidates: Array<{ dir: string, size: number, ageDays: number }>,
 *   skippedWithContent: number,
 *   scanned: number,
 * }}
 */
export function findArchivable(options) {
  const root = String(options?.sessionsRoot ?? '');
  const keepDays = Math.max(1, Number(options?.keepDays) || 7);
  const now = Number(options?.now) || Date.now();
  const onlyEmpty = options?.onlyEmpty !== false;
  const settleMs = keepDays * 24 * 60 * 60 * 1000;

  const out = { candidates: [], skippedWithContent: 0, scanned: 0 };
  if (!root || !fs.existsSync(root)) return out;

  // 结构：sessions/<--cwd-->/<session-xxx>/session.v4.jsonl.zstd
  let profileDirs = [];
  try {
    profileDirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }

  for (const pd of profileDirs) {
    // 只处理 profile 下的（--...-- 那层），避免误伤别的目录
    if (!pd.startsWith('--')) continue;
    const profilePath = path.join(root, pd);
    let sessions = [];
    try {
      sessions = fs.readdirSync(profilePath, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const s of sessions) {
      const dir = path.join(profilePath, s);
      const file = path.join(dir, SESSION_FILE);
      if (!fs.existsSync(file)) continue;
      out.scanned += 1;
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const ageMs = now - st.mtimeMs;
      if (ageMs < settleMs) continue; // 还没到日子

      const meta = readSessionMeta(file);
      if (!meta) continue; // 读不出来就不动
      if (meta.preset !== QQ_PRESET) continue; // 不是 QQ 会话，绝不碰

      if (onlyEmpty && meta.bodyLines > 0) {
        // 有对话内容的：先留着。里面有东西，删了补不回来。
        out.skippedWithContent += 1;
        continue;
      }

      out.candidates.push({ dir, size: st.size, ageDays: Math.round(ageMs / 86400000) });
    }
  }

  return out;
}

/**
 * 把挑出来的会话移动到备份目录。
 *
 * 用移动不用删除：出问题时把目录挪回去就恢复了。
 *
 * @param {Array<{ dir: string }>} candidates
 * @param {{ backupRoot: string, stamp?: string }} options
 * @returns {{ moved: number, failed: number, target: string }}
 */
export function archiveSessions(candidates, options) {
  const backupRoot = String(options?.backupRoot ?? '');
  const stamp = options?.stamp || new Date().toISOString().slice(0, 10);
  const target = path.join(backupRoot, `qq-archive-${stamp}`);
  const out = { moved: 0, failed: 0, target };

  if (!backupRoot) return out;
  if (!candidates?.length) return out;

  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {
    return out;
  }

  for (const c of candidates) {
    try {
      const name = path.basename(c.dir);
      fs.renameSync(c.dir, path.join(target, name));
      out.moved += 1;
    } catch {
      // 单个失败不影响其它（可能被占用）
      out.failed += 1;
    }
  }

  return out;
}
