/**
 * 表情包图库：把本地表情图库挂到发送链路上。
 *
 * 模型在回复里写一个指令，插件就真的把图片文件发出去（不是纯文本占位）。
 * QQ 侧的图片段要求 `file` 能直接交给协议端（SnowLuma 接受绝对路径），
 * 所以这里用本地路径而不是 URL。
 *
 * 图库是**外部目录**，不随插件分发：用户自己往里塞图。
 * 认不出目录就退回"没有表情包"，不影响主链路。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 模型回复里用于点图的指令：`[表情:开心]` / `[表情:happy]` */
export const MEME_MARKER = /\[表情[:：]\s*([^\]]{1,40})\]/g;

/**
 * 扫一个图库目录：`<root>/<tag>/<file>`。
 * @param {string} root
 * @returns {{ tags: Map<string, string[]>, total: number }}
 */
function scanRoot(root) {
  /** @type {Map<string, string[]>} */
  const tags = new Map();
  let total = 0;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      let files = [];
      try {
        files = fs
          .readdirSync(dir)
          .filter((f) => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
          .map((f) => path.join(dir, f));
      } catch {
        continue;
      }
      if (files.length) {
        tags.set(entry.name.toLowerCase(), files);
        total += files.length;
      }
    }
  } catch {
    /* 目录不存在就返回空图库 */
  }
  return { tags, total };
}

/**
 * 创建图库索引。
 * @param {{ roots?: string[], warn?: (m: string) => void }} [options]
 */
export function createMemeLibrary(options = {}) {
  const roots = (options.roots ?? []).filter(Boolean);
  const warn = options.warn ?? (() => {});
  /** @type {Map<string, string[]>} */
  const tags = new Map();
  let ready = false;

  const build = () => {
    if (ready) return;
    ready = true;
    for (const root of roots) {
      const { tags: found } = scanRoot(root);
      for (const [tag, files] of found) {
        // 同名 tag 合并（两个图库都有 happy，一起用）
        const existing = tags.get(tag) ?? [];
        tags.set(tag, [...existing, ...files]);
      }
    }
    if (tags.size === 0 && roots.length) {
      warn(`表情图库是空的（${roots.join(', ')}），表情包功能不可用`);
    }
  };

  return {
    /** 按 tag 或关键词找图；找不到返回 null */
    pick(query) {
      build();
      const q = String(query ?? '').trim().toLowerCase();
      if (!q) return null;
      // 1) 精确 tag
      if (tags.has(q)) return pickOne(tags.get(q));
      // 2) 文件名里含关键词
      for (const files of tags.values()) {
        const hit = files.find((f) => path.basename(f).toLowerCase().includes(q));
        if (hit) return hit;
      }
      // 3) tag 名互相包含（"开森" 对 happy 不行，但 "angry" 对 "anger" 可以）
      for (const [tag, files] of tags.entries()) {
        if (tag.includes(q) || q.includes(tag)) return pickOne(files);
      }
      return null;
    },
    /** 随机一张（不指定时用） */
    random() {
      build();
      const all = [...tags.values()].flat();
      return all.length ? pickOne(all) : null;
    },
    /** 有哪些 tag（给 prompt 用） */
    tagList() {
      build();
      return [...tags.keys()];
    },
    total() {
      build();
      return [...tags.values()].reduce((n, f) => n + f.length, 0);
    },
  };
}

/** @param {string[]} files */
function pickOne(files) {
  return files[Math.floor(Math.random() * files.length)] ?? null;
}

/**
 * 从模型回复里抠出表情指令并换成图片段。
 *
 * 只在整句就是指令时替换（`[表情:happy]`），避免把正常文字里的方括号误伤。
 * 返回段数组 + 是否用掉了表情。
 *
 * @param {string} text
 * @param {{ pick?: (q: string) => string | null, random?: () => string | null }} lib
 * @returns {{ segments: import('./message.js').Segment[], text: string, usedMeme: boolean }}
 */
export function extractMeme(text, lib) {
  const raw = String(text ?? '');
  let usedMeme = false;
  const segments = [];

  // 先看整句是不是纯指令
  const whole = raw.trim().match(/^\[表情[:：]\s*([^\]]{1,40})\]$/);
  if (whole) {
    // 只按分类找，找不到就是找不到 —— 不能退回随机，否则模型写错分类会乱发图
    const file = lib?.pick?.(whole[1]) ?? null;
    if (file) {
      return { segments: [{ type: 'image', file }], text: '', usedMeme: true };
    }
    // 图库里找不到：整句丢掉，别把方括号发给群里
    return { segments: [], text: '', usedMeme: true };
  }

  // 否则把中间的表情指令抽出来，文字保留，图片跟在后面
  let clean = raw;
  const files = [];
  clean = clean.replace(MEME_MARKER, (_m, q) => {
    const file = lib?.pick?.(q);
    if (file) {
      files.push(file);
      usedMeme = true;
    }
    return '';
  }).trim();

  if (clean) segments.push({ type: 'text', text: clean });
  for (const file of files.slice(0, 1)) segments.push({ type: 'image', file });
  return { segments, text: clean, usedMeme };
}
