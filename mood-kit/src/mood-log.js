/**
 * 情绪历史落盘：面板的走势曲线重启后还在，不用每次从零开始。
 *
 * 跟摘要存储分开存（摘要按会话键覆盖写，历史是按时间追加的流水），
 * 各管各的，一个坏了不影响另一个。
 */
import fs from 'node:fs';
import path from 'node:path';
import { freshPoints } from './fade.js';

/**
 * @param {{ file?: string, max?: number, keepDays?: number, warn?: (m: string) => void }} [options]
 */
export function createMoodLog(options = {}) {
  const file = options.file;
  const max = Math.max(1, options.max ?? 2000);
  // 除了按条数截断，还按天数兜底：超过 keepDays 的旧点一律丢掉（防止上限调大后无限涨）
  const keepDays = Math.max(1, options.keepDays ?? 7);
  const warn = options.warn ?? (() => {});
  /** @type {Array<{at:number,sessionKey:string,mood:string,polarity:number,intensity:number}>} */
  let points = [];
  // 历史累计条数（含已经被裁掉的）。
  //
  // 面板上「情绪点」原来显示 points.length，一到 2000 上限就永远不动 ——
  // 看着像"卡住"，其实是"存满了、最早的被丢掉了"。
  // 现在单独记一个只增不减的总数：裁掉多少就往上加多少。
  let total = 0;
  let loaded = false;
  let dirty = false;
  /**
   * 丢掉太旧的（按时间），再丢掉超额的（按条数）。
   *
   * 时间判断交给 fade.js 的 freshPoints —— 它会先看时间戳像不像真的，
   * 像才裁，不像就只按条数裁，避免把测试数据或写坏的数据误删。
   */
  const prune = () => {
    const before = points.length;
    points = freshPoints(points, keepDays);
    if (points.length > max) points = points.slice(-max);
    // 真删了东西才算脏，避免每次读都触发一次全量重写
    if (points.length !== before) dirty = true;
  };

  const load = () => {
    if (loaded) return;
    loaded = true;
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      // 兼容两种格式：
      //   老格式 —— 直接一个数组
      //   新格式 —— { total, points }，能记住被裁掉的量
      if (Array.isArray(raw)) {
        points = raw.filter((p) => p && typeof p === 'object');
        total = points.length;
      } else if (raw && Array.isArray(raw.points)) {
        points = raw.points.filter((p) => p && typeof p === 'object');
        const saved = Number(raw.total);
        // total 至少不能比现有条数少
        total = Number.isFinite(saved) && saved > points.length ? saved : points.length;
      }
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
      fs.writeFileSync(tmp, JSON.stringify({ total, points }, null, 2), 'utf8');
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
      // 累计计数在 push 里加，不放进 prune ——
      // prune 只在"真删了东西"时才有意义，而每个新点本身就该算一次。
      // （之前放在 prune 里，结果只有裁掉时才 +1，累计数落后一大截。）
      total += 1;
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
    /** 历史累计条数（含已被裁掉的），面板「情绪点」用这个 */
    total() {
      load();
      return Math.max(total, points.length);
    },
  };
}
