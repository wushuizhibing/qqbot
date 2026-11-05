/**
 * 情绪核心：把"一轮对话里产生的情绪"聚合成可持续观察的状态。
 *
 * 设计原则（对外接口就围绕这三条）：
 *   1. **只接收，不产生** —— 情绪由调用方（聊天插件）的模型给出，这里管状态机；
 *   2. **不绑定协议** —— 会话键就是字符串，`group:123` / `user:abc` 都行；
 *   3. **落盘优先** —— 重启不丢，历史和星图能接着画。
 */
import { carryMood, amplifyIntensity, agedIntensity, effectiveIntensity, intensityLabel } from './emotion.js';
import { normalizeMood, normalizeIntensity } from './normalize.js';
import { createMoodLog } from './mood-log.js';
import { displayWeight, freshPoints } from './fade.js';
import { moodDistribution, recentPoints, classifyMood, MOOD_CLASSES } from './mood-stats.js';
import { polarityOf } from './polarity.js';
import { collectPeople, relationSummary } from './people.js';

/** 面板侧情绪历史上限 */
export const MOOD_HISTORY_MAX = 2000;

/** 同一条情绪在这段时间内只更新不新增（避免一句话连写多条点） */
export const MERGE_WINDOW_MS = 5 * 60 * 1000;

/**
 * 建一个情绪点（还没落盘）。
 * @param {{ at?: number, sessionKey?: string, mood?: string, intensity?: number }} next
 */
export function makePoint(next) {
  const mood = String(next?.mood ?? '');
  return {
    at: Number(next?.at) || Date.now(),
    sessionKey: String(next?.sessionKey ?? ''),
    mood,
    polarity: polarityOf(mood),
    intensity: normalizeIntensity(next?.intensity),
  };
}

/**
 * 往历史里推一个点：同一个会话、同一句情绪、5 分钟内只更新时间不新增。
 * @param {ReturnType<typeof makePoint>[]} history
 * @param {{ at?: number, sessionKey?: string, mood?: string, intensity?: number }} next
 */
export function pushMoodPoint(history, next) {
  const point = makePoint(next);
  const last = history[history.length - 1];
  if (
    last &&
    last.sessionKey === point.sessionKey &&
    last.mood === point.mood &&
    point.at - last.at < MERGE_WINDOW_MS
  ) {
    last.at = point.at;
    last.intensity = point.intensity;
    return { point: last, merged: true };
  }
  history.push(point);
  if (history.length > MOOD_HISTORY_MAX) history.splice(0, history.length - MOOD_HISTORY_MAX);
  return { point, merged: false };
}

/**
 * 情绪中枢。
 * @param {{
 *   file?: string,
 *   memoryDir?: string,
 *   max?: number,
 *   keepDays?: number,
 *   warn?: (m: string) => void,
 * }} [options]
 */
export function createMoodState(options = {}) {
  const log = createMoodLog({
    file: options.file,
    max: options.max ?? MOOD_HISTORY_MAX,
    keepDays: options.keepDays ?? 365,
    warn: options.warn,
  });
  /** @type {ReturnType<typeof makePoint>[]} */
  const history = log.all();
  /** 每个会话当前的情绪状态（含摘要侧的原始值，用于 carryMood） */
  /** @type {Map<string, { text?: string, mood?: string, intensity?: number, since?: number, carried?: number }>} */
  const summaries = new Map();

  // 从历史里恢复"每个会话最后一条情绪"。
  //
  // 不恢复的话重启后 current() 全空：人会看到"刚骂完我，它重启一下就当没事了"。
  // 历史点本身已经带了强度（放大后的），按当前时间老化一次就是重启那一刻该有的状态。
  for (const point of history) {
    if (!point.sessionKey || !point.mood) continue;
    summaries.set(point.sessionKey, {
      mood: point.mood,
      // 存的是放大后的强度，carryMood 里会再乘 0.5，所以这里反推回"原始量级"
      intensity: normalizeIntensity(Math.round(normalizeIntensity(point.intensity) / 1.35)),
      since: point.at,
      carried: 0,
    });
  }
  if (summaries.size) {
    options.warn?.(`已从历史恢复 ${summaries.size} 个会话的情绪状态`);
  }

  /**
   * 记录一轮情绪。
   *
   * 调用方把模型给的原始值丢进来，这里负责：
   *   - 去重（模型照抄上一轮 → 当作没给）
   *   - 沿用（连续没新情绪 → 最多续 MAX_CARRY_ROUNDS 轮，然后清空）
   *   - 放大（把模型的保守值拉到能听出来的区间）
   *   - 老化（隔久了自动淡）
   *   - 落盘
   *
   * @param {{ sessionKey: string, mood?: string, intensity?: number, summaryText?: string }} input
   */
  function observe(input) {
    const key = String(input?.sessionKey ?? '');
    const previous = summaries.get(key) ?? null;

    let mood = normalizeMood(input?.mood);
    // 防照抄：和上一轮完全一样 → 当作"这轮没给新情绪"
    if (mood && previous?.mood && mood === previous.mood) mood = '';
    // 记下模型这一轮到底给没给新情绪（后面决定"要不要往历史里写一个点"）
    const freshMood = mood;

    const rawIntensity = mood ? normalizeIntensity(input?.intensity) : 0;
    // 接着走"沿用/清空"状态机（carryMood 会处理 MAX_CARRY_ROUNDS）
    const next = carryMood(
      { text: String(input?.summaryText ?? previous?.text ?? ''), mood, intensity: rawIntensity },
      previous,
    );
    summaries.set(key, next);

    // 最终用于语气的强度：先放大新情绪，再按时间衰减（顺序反了会被下限托住，永远散不掉）
    const intensity = next.mood ? effectiveIntensity({ intensity: next.intensity, since: next.since }) : 0;

    let point = null;
    let merged = false;
    // 只有"模型这轮真的给了新情绪"才写历史点。
    //
    // 沿用的情绪（carryMood 带过来的）只影响下一轮的语气，不该当成新事件记一笔 ——
    // 否则模型打了一晚上"无"，面板上却会冒出一串新点，看起来像它一直在闹情绪。
    if (freshMood && next.mood) {
      const r = pushMoodPoint(history, { sessionKey: key, mood: next.mood, intensity });
      point = r.point;
      merged = r.merged;
      if (!r.merged) log.push(r.point);
    }

    return {
      mood: next.mood ?? '',
      intensity,
      rawIntensity: normalizeIntensity(next.intensity),
      label: intensityLabel(intensity),
      carried: Number(next.carried) || 0,
      classification: next.mood ? classifyMood(next.mood).cls : '平静',
      point,
      merged,
    };
  }

  /**
   * 读某个会话当前的"情绪状态"（给下一轮 prompt 用）。
   * @param {string} sessionKey
   */
  function current(sessionKey) {
    const s = summaries.get(String(sessionKey ?? ''));
    if (!s?.mood) return { mood: '', intensity: 0, label: '', since: 0, carried: 0 };
    const intensity = effectiveIntensity({ intensity: s.intensity, since: s.since });
    return {
      mood: s.mood,
      intensity,
      label: intensityLabel(intensity),
      since: Number(s.since) || 0,
      carried: Number(s.carried) || 0,
    };
  }

  /**
   * 情绪星图数据：不同时间窗的类别占比。
   *
   * 两种调法都支持：`stats('day')` 或 `stats({ window: 'day' })`；
   * 不传就返回三个窗口的全套。
   * @param {'hour'|'day'|'all'|{ window?: 'hour'|'day'|'all' }} [opts]
   */
  function stats(opts) {
    const w = typeof opts === 'string' ? opts : opts?.window;
    const pick = (win) => {
      if (win === 'hour') return moodDistribution(recentPoints(history, 1));
      if (win === 'day') return moodDistribution(recentPoints(history, 24));
      return moodDistribution(history);
    };
    if (w) return pick(w);
    return { all: pick('all'), day: pick('day'), hour: pick('hour') };
  }

  /**
   * 记忆星系数据：从若干群的记忆文件里抽人。
   * @param {{ memoryDir?: string, chatIds?: string[], relationshipOf?: (m: string, id: string) => string }} [opts]
   */
  function people(opts = {}) {
    const list = collectPeople({
      memoryDir: opts.memoryDir ?? options.memoryDir,
      chatIds: opts.chatIds ?? [],
      // 外部注册的判定器优先：让聊天插件当家，免得两边判定分叉
      relationshipOf: opts.relationshipOf ?? options.relationshipOf,
    });
    return { nodes: list, summary: relationSummary(list) };
  }

  /**
   * 历史点（面板曲线用）。
   *
   * 每个点带一个 `weight`（0-1），表示它随时间该显示得多淡 —— 面板据此把
   * 旧点画得淡一点，形成"最近清楚、以前模糊"的层次。
   * 同时把已经超过保留期的点过滤掉（正常会被 mood-log 剪掉，这里是双保险）。
   */
  function points() {
    const now = Date.now();
    const keep = options.keepDays ?? 365;
    return freshPoints(history.slice(-MOOD_HISTORY_MAX), keep, now).map((p) => ({
      ...p,
      weight: displayWeight(p.at, now),
    }));
  }

  /** 最近一个点 */
  function latest() {
    return history.length ? history[history.length - 1] : null;
  }

  /** 立刻落盘（退出时调） */
  function save() {
    log.save();
  }

  return {
    observe,
    current,
    stats,
    people,
    points,
    latest,
    save,
    /**
     * 历史累计条数（含已被上限裁掉的）。
     *
     * 面板上的「情绪点」原来用 points.length，一到上限就永远显示 2000，
     * 看着像卡住了。换成这个才是真·累计。
     */
    total: () => log.total(),
    /** 底层历史数组（面板直接渲染用；改它后果自负） */
    get history() {
      return history;
    },
    /** 类别清单（面板画雷达图的维度） */
    classes: MOOD_CLASSES,
  };
}

export { classifyMood, moodDistribution, recentPoints, MOOD_CLASSES };
export { carryMood, amplifyIntensity, agedIntensity, effectiveIntensity, intensityLabel } from './emotion.js';
export { normalizeMood, normalizeIntensity } from './normalize.js';
export { polarityOf } from './polarity.js';
export { createMoodLog } from './mood-log.js';
export { collectPeople, relationSummary } from './people.js';
export { relationshipOf, relationshipHint, relationRank } from './relationship.js';
