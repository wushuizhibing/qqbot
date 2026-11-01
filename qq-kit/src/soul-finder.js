/**
 * 灵魂文件的自动发现。
 *
 * 目标：**把 soul.md 往约定位置一放就能用，不用改配置。**
 *
 * 现在的行为：`personaPath` 留空 → 内置中性人格（没个性）。
 * 问题是新人拿到插件后，得先看懂配置、拼对路径才用得上自己的灵魂文件。
 *
 * 这个模块负责在几个常见位置找，找到就用，找不到才退回兜底。
 *
 * 查找顺序（先找到先用）：
 *   1. 显式配置的 personaPath（用户说了算）
 *   2. <cwd>/soul.md                    ← 在 DSH 工作区里放
 *   3. <cwd>/persona/soul.md            ← 推荐
 *   4. <cwd>/qqbot-memory/persona/soul.md
 *   5. <DSH_HOME>/soul.md
 *   6. <插件目录>/soul.md                ← 不想动工作区就放插件里
 *
 * 用 `personaPath: ''` 表示"自动找"，`personaPath: false` 表示"坚决不用"。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 找到的候选文件名（相对目录） */
export const CANDIDATES = [
  'soul.md',
  'persona/soul.md',
  'SOUL.md',
  'Persona/soul.md',
  'qqbot-memory/persona/soul.md',
  '.dsh/persona/soul.md',
];

/**
 * 按顺序找一个存在的灵魂文件。
 *
 * @param {{ explicit?: string|false|null, roots?: string[], warn?: (m: string) => void }} options
 * @returns {{ path: string, source: string } | null}
 */
export function findSoulFile(options = {}) {
  const { explicit } = options;

  // 显式配置优先。false 表示"我就是不要"，直接返回 null。
  if (explicit === false) return null;
  if (typeof explicit === 'string' && explicit.trim()) {
    const p = explicit.trim();
    if (fs.existsSync(p)) return { path: p, source: 'config' };
    options.warn?.(`配置的 personaPath 不存在（${p}），改用自动查找`);
  }

  // 自动查找的根目录，按优先级
  const roots =
    options.roots?.filter(Boolean) ??
    [
      process.cwd(),
      process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
      path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..'),
    ].filter(Boolean);

  for (const root of roots) {
    for (const rel of CANDIDATES) {
      const full = path.join(root, rel);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return { path: full, source: root === process.cwd() ? 'cwd' : rel };
        }
      } catch {
        /* 没权限之类的，跳过继续找 */
      }
    }
  }
  return null;
}

/**
 * 人话描述"灵魂文件该放哪"——给日志和报错用。
 * @param {string[]} [roots]
 */
export function describeSoulLocations(roots) {
  const cwd = roots?.[0] ?? process.cwd();
  return [
    `把灵魂文件（soul.md）放到下面任一位置就能直接用：`,
    `  ${path.join(cwd, 'soul.md')}`,
    `  ${path.join(cwd, 'persona', 'soul.md')}   ← 推荐`,
    `或者显式指定 personaPath。没有的话会用内置的中性人格（不像客服，但没有个性）。`,
  ].join('\n');
}
