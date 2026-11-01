/**
 * 代码新鲜度检查：改了源码但没重启 DSH 时，在面板上提醒一句。
 *
 * 为什么需要：这个插件的服务端代码（分类器、状态机、面板 HTML 本身）
 * 是 **apply 时一次性加载进内存** 的。改完文件不重启，跑的仍是旧代码 ——
 * 但面板看起来一切正常，于是很容易误判成"我改的没生效/有 bug"。
 * （2026-10-31 就因为这个在"星图 100% 平静"上排查了半天。）
 *
 * 做法：启动时把关键文件的 mtime 记下来，之后每次请求比对一次。
 * 有差异就说明磁盘上的代码比进程里的新。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 需要盯的文件（相对于插件根目录）。加新模块时记得往这里加。 */
export const WATCHED = [
  'index.js',
  'lib/client.js',
  'src/core.js',
  'src/emotion.js',
  'src/fade.js',
  'src/mood-stats.js',
  'src/mood-log.js',
  'src/normalize.js',
  'src/people.js',
  'src/polarity.js',
  'src/relationship.js',
  'src/panel-hub.js',
  'src/panel.js',
  'src/staleness.js',
];

/** 插件根目录（本文件在 src/ 下，上一级就是根） */
export const ROOT = path.resolve(HERE, '..');

/**
 * 读一个文件的 mtime（毫秒）。读不到返回 0。
 * @param {string} file
 */
function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 记一份"启动时的快照"。
 * @param {string} [root]
 * @returns {Map<string, number>}
 */
export function snapshot(root = ROOT) {
  const snap = new Map();
  for (const rel of WATCHED) snap.set(rel, mtimeOf(path.join(root, rel)));
  return snap;
}

/**
 * 跟快照比对，返回改动过的文件。
 *
 * @param {Map<string, number>} snap 启动时拍的快照
 * @param {string} [root]
 * @returns {Array<{ file: string, changedAt: number }>}
 */
export function changedSince(snap, root = ROOT) {
  const out = [];
  for (const [rel, old] of snap) {
    const now = mtimeOf(path.join(root, rel));
    // 文件新出现（old=0）也算变更；被删掉（now=0）不算 —— 可能是发布时排除了
    if (now !== 0 && now > old) out.push({ file: rel, changedAt: now });
  }
  return out;
}
