/**
 * 情绪：不做建模，只做"别丢得太干净"。
 *
 * 情绪本身不单独存储 —— 它是摘要里的一个字段（见 bridge.js 的 Summary.mood），
 * 跟着本来就要跑的总结子代理一起更新。这里只处理一个边角：
 * 总结子代理如实说"这批没影响我"时，上一轮还热着的情绪不该当场归零。
 *
 * 不搞衰减曲线、不搞半衰期：下一轮摘要重写时，旧情绪自然被新对话冲掉。
 */
import { normalizeMood, normalizeIntensity } from './bridge.js';
import { MOOD_DECAY } from './bridge.js';

// 情绪状态机（沿用上限、老化、放大）现在由 dsh-mood-kit 提供；
// 这里保留转发，让没装 mood-kit 的内置实现和其它旧调用方继续可用。
export {
  amplifyIntensity,
  agedIntensity,
  intensityLabel,
  MOOD_DECAY,
  INTENSITY_GAIN,
  FLAT_FLOOR,
} from './bridge.js';

/** 老化后低于这个值就当没了（和 dsh-mood-kit 的 DECAY_FLOOR 保持一致） */
export const DECAY_FLOOR = 2;

/**
 * 老化 + 放大，顺序做对：先放大新情绪，再按时间衰减，衰减到极低就归零。
 *
 * 为什么不能"先老化再放大"：FLAT_FLOOR 会把任何 >0 的强度托到 2，
 * 于是隔了一天的情绪永远停在 2，看起来永远散不掉。
 * @param {{ intensity?: number, since?: number }} mood
 * @param {number} [now]
 */
export function effectiveIntensity(mood, now = Date.now()) {
  const base = normalizeIntensity(mood?.intensity);
  if (base <= 0) return 0;
  const fresh = normalizeIntensity(Math.max(2, base * 1.35)); // FLAT_FLOOR / INTENSITY_GAIN
  const since = Number(mood?.since);
  if (!Number.isFinite(since) || since <= 0) return fresh;
  const elapsed = Math.max(0, now - since);
  let factor = 1;
  for (const step of MOOD_DECAY) {
    if (elapsed >= step.afterMs) factor = step.factor;
  }
  const decayed = normalizeIntensity(fresh * factor);
  return decayed < DECAY_FLOOR ? 0 : decayed;
}

/** 一次"没受影响"之后，情绪保留到原文的多少（够下一轮还说得出"刚被怼了"） */
export const CARRY_RATIO = 0.5;

/** 沿用最多几轮：连着沿用这么多轮还没新情绪，就当真没了（防止一句话挂一整天） */
export const MAX_CARRY_ROUNDS = 2;

/**
 * 沿用的时间窗：距上次真正更新超过这么久，就不再沿用。
 *
 * 为什么光有轮数不够：`carried` 跟着**调用次数**涨，而调用只在"有消息进来"时发生。
 * 群里安静 15 分钟再来一条，carried 还停在上次的值，同一句情绪又能续两轮 ——
 * 实际表现就是"一段情绪挂半小时不变"。时间窗按真实时间判断，不受消息密度影响。
 */
export const CARRY_WINDOW_MS = 10 * 60 * 1000;

/**
 * 新一轮摘要的情绪 vs 上一轮。
 *
 * 1. 上一轮没情绪 → 原样返回
 * 2. 这一轮有情绪 → 用新的（新的永远优先，并重置沿用计数）
 * 3. 这一轮空、上一轮有 → 带一半强度过去，但受两个上限约束：
 *    **最多沿用 MAX_CARRY_ROUNDS 轮**，且**距上次更新不超过 CARRY_WINDOW_MS**；
 *    超了任一条就清空 —— 否则一句旧情绪会一直挂着不动，看起来像情绪系统卡死了。
 *
 * @param {{ mood?: string, intensity?: number, since?: number, carried?: number }} [next] 刚跑出来的摘要
 * @param {{ mood?: string, intensity?: number, since?: number, carried?: number }} [previous] 上一轮的摘要
 * @param {number} [now] 当前时间（测试用）
 * @returns {{ mood?: string, intensity?: number, since?: number, carried?: number }} 处理后的摘要（不改原对象）
 */
export function carryMood(next, previous, now = Date.now()) {
  const fresh = normalizeMood(next?.mood);
  if (fresh) return { ...next, mood: fresh, carried: 0 };
  const old = normalizeMood(previous?.mood);
  if (!old) return { ...next, mood: '', intensity: 0, since: 0, carried: 0 };

  // 时间窗：距上次真正更新太久了，直接散掉（别靠"调用次数"续命）
  const sinceAt = Number(previous?.since);
  if (Number.isFinite(sinceAt) && sinceAt > 0 && now - sinceAt > CARRY_WINDOW_MS) {
    return { ...next, mood: '', intensity: 0, since: 0, carried: 0 };
  }

  // 已经沿用够多轮了：让它自然消失，别无限续命
  const carriedSoFar = Number(previous?.carried) || 0;
  if (carriedSoFar >= MAX_CARRY_ROUNDS) {
    return { ...next, mood: '', intensity: 0, since: 0, carried: 0 };
  }

  // 衰减残留：强度砍一半，since 保留原起点（老化逻辑接着生效）。
  //
  // 文字**不再截短**：以前用 shorten() 把上一轮的句子截一半，连续几轮残留下来
  // 会变成"被点名 → 被点 → 被"这种残句，看起来像坏了。情绪该淡就淡强度，
  // 文字本身保持完整。
  return {
    ...next,
    mood: old,
    intensity: normalizeIntensity(Math.round(normalizeIntensity(previous?.intensity) * CARRY_RATIO)),
    since: Number.isFinite(previous?.since) ? previous.since : Date.now(),
    carried: carriedSoFar + 1,
  };
}

/**
 * 把一句话截到一半长度，尽量截在标点/空格处，别把词砍断。
 * @param {string} text
 * @returns {string}
 */
export function shorten(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  const half = Math.max(2, Math.ceil((raw.length * CARRY_RATIO) / 2));
  if (raw.length <= half) return raw;
  const head = raw.slice(0, half);
  // 优先在最后一个分隔符处断开，读起来像"半句残留"而不是乱码
  const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf(' '));
  return (cut > 1 ? head.slice(0, cut) : head).trim();
}
