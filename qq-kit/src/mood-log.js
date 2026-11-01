/**
 * 情绪历史落盘：面板的走势曲线重启后还在，不用每次从零开始。
 *
 * 跟摘要存储分开存（摘要按会话键覆盖写，历史是按时间追加的流水），
 * 各管各的，一个坏了不影响另一个。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {{ file?: string, max?: number, keepDays?: number, warn?: (m: string) => void }} [options]
 */
export function createMoodLog(options = {}) {
  const file = options.file;
  const max = Math.max(1, options.max ?? 2000);
  // 除了按条数截断，还按天数兜底：超过 keepDays 的旧点一律丢掉（防止上限调大后无限涨）
  const keepDays = Math.max(1, options.keepDays ?? 7);
  const keepMs = keepDays * 24 * 60 * 60 * 1000;
  const warn = options.warn ?? (() => {});
  /** @type {Array<{at:number,sessionKey:string,mood:string,polarity:number,intensity:number}>} */
  let points = [];
  let loaded = false;
  let dirty = false;

  /**
   * 丢掉太旧的（按时间），再丢掉超额的（按条数）。
   *
   * 保守策略：只有当整批数据的时间戳看起来像"正常的毫秒时间戳"时才按时间裁剪。
   * 否则（比如测试里用的小数字、或者写坏了的时间戳）只按条数裁，避免把好数据误删。
   */
  const prune = () => {
    const cutoff = Date.now() - keepMs;
    const ats = points.map((p) => Number(p.at)).filter(Number.isFinite);
    // 最新一个点也要晚于 2020 才认为是真实时间戳（1.6e12）
    const looksReal = ats.length > 0 && Math.max(...ats) > 1_577_836_800_000;
    if (looksReal) {
      points = points.filter((p) => {
        const at = Number(p.at);
        return !Number.isFinite(at) || at >= cutoff; // 时间戳坏的先留着，别误删
      });
    }
    if (points.length > max) points = points.slice(-max);
  };

  const load = () => {
    if (loaded) return;
    loaded = true;
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw)) points = raw.filter((p) => p && typeof p === 'object');
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return;
      warn(`读取情绪历史失败（${file}）：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const flush = () => {
    if (!file || !dirty) return;
    dirty = false;
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(points, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      warn(`写入情绪历史失败（${file}）：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    /** 启动时读回来（顺手清掉太旧的） */
    all() {
      load();
      const before = points.length;
      prune();
      if (points.length !== before) {
        dirty = true;
        flush();
      }
      return points.slice(-max);
    },
    /** 追加一个点（超过上限或太旧就自动丢最早的） */
    push(point) {
      load();
      points.push(point);
      prune();
      dirty = true;
      // 每条都落盘：情绪点不多（一轮一个），不会成为 IO 负担
      flush();
    },
    /** 立刻落盘 */
    save() {
      flush();
    },
    size() {
      load();
      return points.length;
    },
  };
}
