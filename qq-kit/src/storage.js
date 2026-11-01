/**
 * 会话持久化：让摘要跨重启活下来。
 *
 * 存一个 JSON 文件就够（每个会话一条摘要，最多几十个群）。
 * 写入用「临时文件 + rename」，避免写一半断电把整个文件写坏。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {{ file?: string, warn?: (m: string) => void }} options
 */
export function createStore(options = {}) {
  const file = options.file;
  const warn = options.warn ?? (() => {});
  /** @type {Record<string, { text?: string, facts?: string[], mood?: string, updatedAt?: number }>} */
  let data = {};
  let loaded = false;
  let dirty = false;

  const load = () => {
    if (loaded) return;
    loaded = true;
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) data = raw;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return;
      warn(`读取摘要存储失败（${file}）：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const flush = () => {
    if (!file || !dirty) return;
    dirty = false;
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      warn(`写入摘要存储失败（${file}）：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    /** @param {string} key */
    get(key) {
      load();
      return data[key] ?? null;
    },
    /** @param {string} key @param {{ text?: string, facts?: string[], mood?: string }} summary */
    set(key, summary) {
      load();
      data[key] = {
        text: String(summary?.text ?? ''),
        facts: Array.isArray(summary?.facts) ? summary.facts.map(String) : [],
        // 情绪跟着摘要一起存：重启后"上一轮的心情"还在
        mood: String(summary?.mood ?? ''),
        // 强度和起点也存：否则重启后强度归零、老化重新计时
        intensity: Number(summary?.intensity) || 0,
        since: Number(summary?.since) || 0,
        // 沿用轮数也要存，否则重启后沿用计数清零，旧情绪又能续命两轮
        carried: Number(summary?.carried) || 0,
        updatedAt: Date.now(),
      };
      dirty = true;
    },
    /** 立刻落盘（退出时调一次） */
    save() {
      flush();
    },
    /** 已存了多少个会话（面板用） */
    size() {
      load();
      return Object.keys(data).length;
    },
    /** 全部键（调试用） */
    keys() {
      load();
      return Object.keys(data);
    },
  };
}
