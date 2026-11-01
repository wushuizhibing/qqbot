/**
 * 情绪状态机：强度、放大、老化、沿用。
 *
 * 核心想法：情绪不是一个数值，而是一条"有起落、会淡、不会无限续命"的曲线。
 * 这里不调模型、不存摘要 —— 只负责把调用方给的原始情绪变成"这轮该用什么语气"。
 *
 * 两个关键机制：
 *   1. **放大**（amplifyIntensity）：模型给的强度天生保守，乘个系数让它听得出来；
 *   2. **老化**（agedIntensity）：隔了几小时，旧情绪该淡下去，不能一直摆脸色。
 *   3. **沿用上限**（MAX_CARRY_ROUNDS）：模型连续说"没情绪"时最多续 2 轮，然后清空。
 */
import { normalizeMood, normalizeIntensity } from './normalize.js';

export { normalizeMood, normalizeIntensity, MOOD_MAX, MOOD_INTENSITY_MAX } from './normalize.js';

/**
 * 强度放大系数：让情绪有起伏，别都挤在 1-4 这个安全区里。
 *
 * 线性放大 1.35 倍，再加下限：
 *   1-2 抬到 2-3（有情绪就听得出）→ 3-4 抬到 4-5（明显）→ 7-8 抬到 9-10（重/上头）
 * 0 仍是 0（没情绪不能凭空造）；有情绪时至少 FLAT_FLOOR。
 */
export const INTENSITY_GAIN = 1.35;

/** 有情绪时的最低强度：表达出来就至少让人听得出。 */
export const FLAT_FLOOR = 2;

/**
 * 老化分界：超过这些毫秒，强度按比例打折（不是消失，是变淡）。
 *
 * 分两段而不是一段，是因为 0.15 这个系数在"先放大后衰减"的算法下
 * 顶格 10 × 0.15 = 1.5 → 取整还是 2，情绪于是一天之后也散不掉（实测到第 10 天仍是 2）。
 * 一天之后再加一档 0.08，让"隔了一天"的情绪真的退到 1 以下、自然归零。
 */
export const MOOD_DECAY = Object.freeze([
  { afterMs: 6 * 60 * 60 * 1000, factor: 0.5 },    // 6 小时后：减半
  { afterMs: 12 * 60 * 60 * 1000, factor: 0.3 },   // 半天后：剩三成
  { afterMs: 24 * 60 * 60 * 1000, factor: 0.08 },  // 一天后：几乎没有
]);

/** 一次"没受影响"之后，情绪保留到原文的多少（够下一轮还说得出"刚被怼了"） */
export const CARRY_RATIO = 0.5;

/** 沿用最多几轮：连着沿用这么多轮还没新情绪，就当真没了（防止一句话挂一整天） */
export const MAX_CARRY_ROUNDS = 2;

/**
 * 沿用的时间窗：距上次真正更新超过这么久，就不再沿用。
 *
 * 为什么光有轮数不够：`carried` 是跟着**调用次数**涨的，而调用只在"有消息进来"时发生。
 * 群里安静了 20 分钟再来一条，carried 还停在上次的值，于是同一句情绪又能"续两轮"——
 * 实际观察到的就是"一段情绪挂半小时不变"。时间窗按真实时间判断，不受消息密度影响。
 */
export const CARRY_WINDOW_MS = 10 * 60 * 1000;

/**
 * 情绪彻底淡掉的门槛：老化后低于这个值就当没了。
 *
 * 为什么需要：FLAT_FLOOR 会把任何 >0 的强度托到 2，于是"一天前的一点不爽"
 * 会永远停在 2（测过 240 小时后还是 2），看起来情绪永远散不掉。
 * 老化归老化，托底只该对"新情绪"生效。
 *
 * 取 2 而不是 1：强度是 0-10 的整数，1 已经听不出来什么了，
 * 留在 1 只会让面板上挂着一条"几乎没情绪"的空壳。
 */
export const DECAY_FLOOR = 2;

/**
 * 把模型给的原始强度放大成"实际语气强度"。
 *
 * 只对**刚产生**的情绪用，别对已经老化过的值用（那会把快消失的情绪托回来）。
 * @param {unknown} raw
 * @returns {number}
 */
export function amplifyIntensity(raw) {
  const base = normalizeIntensity(raw);
  if (base <= 0) return 0;
  return normalizeIntensity(Math.max(FLAT_FLOOR, base * INTENSITY_GAIN));
}

/**
 * 老化 + 放大，一步做对顺序：先放大新情绪，再按时间衰减，衰减到极低就归零。
 *
 * 顺序很重要：先老化再放大，FLAT_FLOOR 会把快没的情绪托回 2，永远散不掉。
 * @param {{ intensity?: number, since?: number }} mood
 * @param {number} [now]
 */
export function effectiveIntensity(mood, now = Date.now()) {
  const fresh = amplifyIntensity(normalizeIntensity(mood?.intensity));
  if (fresh <= 0) return 0;
  const since = Number(mood?.since);
  if (!Number.isFinite(since) || since <= 0) return fresh;
  const elapsed = Math.max(0, now - since);
  let factor = 1;
  for (const step of MOOD_DECAY) {
    if (elapsed >= step.afterMs) factor = step.factor;
  }
  const decayed = normalizeIntensity(fresh * factor);
  // 衰减到门槛以下就当没了：别再被 FLAT_FLOOR 之类的东西捞回来
  return decayed < DECAY_FLOOR ? 0 : decayed;
}

/**
 * 强度 → 给模型看的一档语气提示。空串表示没情绪。
 * @param {number} intensity
 * @returns {string}
 */
export function intensityLabel(intensity) {
  const n = normalizeIntensity(intensity);
  if (n <= 0) return '';
  if (n <= 2) return '很淡（几乎不影响语气，别演）';
  if (n <= 4) return '轻（语气稍微变一点，别夸张）';
  if (n <= 6) return '明显（能听出来，但仍然别解释自己在不爽）';
  if (n <= 8) return '重（话更短，懒得展开，但别阴阳）';
  return '上头（几乎不想说长句，能一个字就一个字，但别伤人）';
}

/**
 * 情绪老化：按距离 since 多久，把强度打折。
 * 只降不升；没有 since 就按"刚发生"处理（拿不到起点时宁可当新鲜）。
 * @param {{ intensity?: number, since?: number }} mood
 * @param {number} [now]
 * @returns {number}
 */
export function agedIntensity(mood, now = Date.now()) {
  const base = normalizeIntensity(mood?.intensity);
  if (base <= 0) return 0;
  const since = Number(mood?.since);
  if (!Number.isFinite(since) || since <= 0) return base;
  const elapsed = Math.max(0, now - since);
  let factor = 1;
  for (const step of MOOD_DECAY) {
    if (elapsed >= step.afterMs) factor = step.factor;
  }
  return normalizeIntensity(base * factor);
}

/**
 * 新一轮摘要的情绪 vs 上一轮。
 *
 * 1. 上一轮没情绪 → 原样返回
 * 2. 这一轮有情绪 → 用新的（新的永远优先，并重置沿用计数）
 * 3. 这一轮空、上一轮有 → 带一半强度过去，但**最多沿用 MAX_CARRY_ROUNDS 轮**；
 *    超过就清空 —— 否则模型每轮都说"没情绪"时，一句旧情绪会一直挂着不动，
 *    看起来像情绪系统卡死了（实际是残留逻辑太粘）。
 *
 * @param {{ mood?: string, intensity?: number, since?: number, carried?: number }} [next]
 * @param {{ mood?: string, intensity?: number, since?: number, carried?: number }} [previous]
 * @returns {{ mood?: string, intensity?: number, since?: number, carried?: number }}
 */
export function carryMood(next, previous, now = Date.now()) {
  const fresh = normalizeMood(next?.mood);
  if (fresh) return { ...next, mood: fresh, carried: 0 };
  const old = normalizeMood(previous?.mood);
  if (!old) return { ...next, mood: '', intensity: 0, since: 0, carried: 0 };

  // 时间窗：距上次真正更新太久了，就直接散掉。
  // carried 记的是"调用了几次"，群里安静一小时再来一条也会被判成"紧跟着"，所以必须看真实时间。
  const since = Number(previous?.since);
  if (Number.isFinite(since) && since > 0 && now - since > CARRY_WINDOW_MS) {
    return { ...next, mood: '', intensity: 0, since: 0, carried: 0 };
  }

  // 已经沿用够多轮了：让它自然消失，别无限续命
  const carriedSoFar = Number(previous?.carried) || 0;
  if (carriedSoFar >= MAX_CARRY_ROUNDS) {
    return { ...next, mood: '', intensity: 0, since: 0, carried: 0 };
  }

  // 衰减残留：强度砍一半，since 保留原起点（老化逻辑接着生效）。
  //
  // 文字**不截短**：以前把上一轮的句子截一半，连续几轮残留下来会变成
  // "被点名 → 被点 → 被"这种残句，看起来像坏了。情绪该淡就淡强度。
  return {
    ...next,
    mood: old,
    intensity: normalizeIntensity(Math.round(normalizeIntensity(previous?.intensity) * CARRY_RATIO)),
    since: Number.isFinite(previous?.since) ? previous.since : now,
    carried: carriedSoFar + 1,
  };
}
