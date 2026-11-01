/**
 * 消息合并器：把同一个会话里短期内连续的消息合成一批，再交给思考子代理。
 *
 * 规则（2026-10-29 定）：
 *   - 消息**一条不漏**地进窗口，合并只决定"什么时候触发思考"，不丢消息；
 *   - 热闹时按 perMinute 限流，超出的攒到下一次窗口一并处理，而不是丢弃。
 *   - 冷场由调用方（index.js）判断后调 flush()，这里不重复一套判定。
 */
import { sessionKeyOf } from './session.js';

/**
 * @typedef {object} MergeOptions
 * @property {number} [windowMs]     思考触发窗口：最后一条消息之后等这么久再 flush
 * @property {number} [maxMessages]  一批最多几条，超了就立刻 flush
 * @property {number} [maxWaitMs]    从第一条算最多等多久，防止一直有人说话导致永远不 flush
 * @property {number} [perMinute]    每个会话每分钟最多触发几次（0 = 不限）。
 *   可以给小数：0.5 = 每 2 分钟一次，0.2 = 每 5 分钟一次（退化成固定间隔）。
 * @property {(msg: any) => boolean} [isUrgent] 判定"必须马上处理、不受限流"的消息（例如被 @）
 */

const DEFAULTS = Object.freeze({
  windowMs: 500,
  maxMessages: 20,
  maxWaitMs: 8000,
  perMinute: 6,
  isUrgent: null,
});

/**
 * @param {MergeOptions} [options]
 */
export function createMerger(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  /** @type {Map<string, { items: any[], firstAt: number, timer: any, lastAt: number }>} */
  const buckets = new Map();
  /** @type {Map<string, number[]>} 每个会话最近的触发时间戳（用于限流） */
  const fired = new Map();
  /** 外部注册的 flush 回调 */
  let onFlush = null;
  let closed = false;

  // 和会话键用同一套规则，回调里拿到的 key 可以直接当会话键用
  const keyOf = (msg) => sessionKeyOf(msg);

  /**
   * 本会话最近一次触发时间。
   * 注意：不能用 fired 数组，那个会被 recentFires 按"一分钟窗口"清空；
   * 小数 perMinute 需要跨越超过一分钟的间隔，所以单独记一份。
   * @type {Map<string, number>}
   */
  const lastFireAt = new Map();

  /** 本会话过去一分钟触发了多少次 */
  const recentFires = (key, now) => {
    const list = (fired.get(key) ?? []).filter((t) => now - t < 60000);
    fired.set(key, list);
    return list.length;
  };

  /**
   * 本会话此刻还有没有触发额度。
   *
   * perMinute 允许小数（比如 0.5 = 每 2 分钟一次）：此时退化成"固定间隔"，
   * 间隔 = 60000 / perMinute 毫秒 —— 距离上次触发不够间隔就一直等着。
   * 用整数时是原来的"每分钟最多 N 次"。
   */
  const hasQuota = (key, now) => {
    const pm = Number(opts.perMinute);
    if (!(pm > 0)) return true; // 0 或负数 = 不限
    if (pm >= 1) return recentFires(key, now) < pm;
    const gap = 60000 / pm;
    const last = lastFireAt.get(key) ?? 0;
    return now - last >= gap;
  };

  const doFlush = (key) => {
    const bucket = buckets.get(key);
    if (!bucket) return;
    buckets.delete(key);
    if (bucket.timer) clearTimeout(bucket.timer);
    const stamp = Date.now();
    lastFireAt.set(key, stamp);
    if (opts.perMinute > 0) {
      const list = fired.get(key) ?? [];
      list.push(stamp);
      fired.set(key, list);
    }
    try {
      onFlush?.(key, bucket.items);
    } catch {
      // 下游出错不能影响后续消息
    }
  };

  const schedule = (key, force = false) => {
    const bucket = buckets.get(key);
    if (!bucket) return;
    if (bucket.timer) clearTimeout(bucket.timer);
    const now = Date.now();
    const base = Math.min(opts.windowMs, Math.max(0, bucket.firstAt + opts.maxWaitMs - now));
    bucket.timer = setTimeout(() => {
      // 限流：跳过的这次不丢消息，重新排到下一个窗口（重新计时，不久等）
      if (!force && !hasQuota(key, Date.now())) {
        bucket.firstAt = Date.now();
        schedule(key);
        return;
      }
      doFlush(key);
    }, Math.max(0, base));
    if (typeof bucket.timer?.unref === 'function') bucket.timer.unref();
  };

  return {
    /** @param {(key: string, items: any[]) => void} handler */
    setHandler(handler) {
      onFlush = handler;
    },

    /** 投递一条消息（一条不漏）。被 @ 的消息标记为 urgent，绕过限流立刻触发。 */
    push(msg) {
      if (closed) return;
      const key = keyOf(msg);
      const now = Date.now();
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { items: [], firstAt: now, timer: null, lastAt: 0, urgent: false };
        buckets.set(key, bucket);
      }
      bucket.lastAt = now;
      bucket.items.push(msg);
      // 被 @：这是有人在叫我们，不能被限流压住
      if (opts.isUrgent?.(msg)) bucket.urgent = true;
      if (bucket.items.length >= opts.maxMessages) {
        doFlush(key); // 攒满：立刻发，不受限流影响
        return;
      }
      if (bucket.urgent) {
        doFlush(key);
        return;
      }
      schedule(key);
    },

    /** 立刻 flush 某个会话（调用方判断冷场后用它绕过窗口） */
    flush(key) {
      doFlush(key);
    },

    /** flush 全部并关闭 */
    close() {
      closed = true;
      for (const key of [...buckets.keys()]) doFlush(key);
    },

    /** 当前待处理数量（测试用） */
    pending() {
      return [...buckets.values()].reduce((n, b) => n + b.items.length, 0);
    },

    /** 配置快照（调试用） */
    options() {
      return { ...opts };
    },

    /**
     * 热更新合并参数（不重建合并器，已有桶和计时器保留）。
     * @param {Partial<MergeOptions>} next
     */
    setOptions(next) {
      if (!next || typeof next !== 'object') return { ...opts };
      Object.assign(opts, next);
      return { ...opts };
    },
  };
}
