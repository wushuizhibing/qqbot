/**
 * 内置情绪实现：没装 dsh-mood-kit 时的降级方案。
 *
 * 直接复用 qq-kit 自己的 src 模块（emotion / mood-stats / mood-log / people），
 * 行为和 dsh-mood-kit 一致，区别只是：
 *   - 没有独立面板（数据仍走 qq-kit 面板）
 *   - 不提供 ctx.moodKit（因为不是那个插件）
 *
 * 目的是"没装 mood-kit 也不缺功能"，而不是长期维护两套。
 */
import os from 'node:os';
import path from 'node:path';

import { carryMood, amplifyIntensity, agedIntensity, effectiveIntensity, intensityLabel } from './emotion.js';
import { normalizeMood, normalizeIntensity } from './bridge.js';
import { createMoodLog } from './mood-log.js';
import { moodDistribution, recentPoints, classifyMood, MOOD_CLASSES } from './mood-stats.js';
import { polarityOf } from './panel.js';
import { collectPeople, relationSummary } from './people.js';

/** 同一条情绪在这段时间内只更新不新增 */
const MERGE_WINDOW_MS = 5 * 60 * 1000;
const MAX_POINTS = 2000;

/**
 * 建一个内置情绪中枢（接口对齐 dsh-mood-kit 的 ctx.moodKit）。
 * @param {object} config
 * @param {(level: string, msg: string) => void} log
 */
export function createBuiltinMood(config, log) {
  const file =
    config.moodFile === false
      ? ''
      : (config.moodFile || path.join(process.env.DSH_HOME ?? os.homedir(), 'qq-kit-moods.json'));
  const logger = createMoodLog({
    file,
    max: Number(config.moodHistoryMax) || MAX_POINTS,
    keepDays: Number(config.moodKeepDays) || 7,
    warn: (m) => log('warn', m),
  });
  /** @type {any[]} */
  const history = logger.all();
  /** @type {Map<string, any>} */
  const summaries = new Map();
  if (file) log('info', `情绪历史：${file}（已有 ${history.length} 个点）`);

  // 从历史恢复各会话最后的情绪：不恢复的话重启后 current() 全空，
  // 人会看到"刚骂完我，它重启一下就当没事了"。
  for (const point of history) {
    if (!point.sessionKey || !point.mood) continue;
    summaries.set(point.sessionKey, {
      mood: point.mood,
      // 历史里存的是放大后的强度，除回去还原成原始量级
      intensity: normalizeIntensity(Math.round(normalizeIntensity(point.intensity) / 1.35)),
      since: point.at,
      carried: 0,
    });
  }

  function pushPoint(sessionKey, moodText, intensity) {
    const at = Date.now();
    const last = history[history.length - 1];
    if (
      last &&
      last.sessionKey === sessionKey &&
      last.mood === moodText &&
      at - last.at < MERGE_WINDOW_MS
    ) {
      last.at = at;
      last.intensity = intensity;
      return { point: last, merged: true };
    }
    const point = {
      at,
      sessionKey,
      mood: moodText,
      polarity: polarityOf(moodText),
      intensity: normalizeIntensity(intensity),
    };
    history.push(point);
    if (history.length > MAX_POINTS) history.splice(0, history.length - MAX_POINTS);
    logger.push(point);
    return { point, merged: false };
  }

  return {
    observe(input) {
      const key = String(input?.sessionKey ?? '');
      const previous = summaries.get(key) ?? null;

      let moodText = normalizeMood(input?.mood);
      // 防照抄：和上一轮完全一样 → 当作没给新情绪
      if (moodText && previous?.mood && moodText === previous.mood) moodText = '';
      // 记下模型这轮到底给没给新情绪（后面决定要不要写历史点）
      const freshMood = moodText;

      const rawIntensity = moodText ? normalizeIntensity(input?.intensity) : 0;
      const next = carryMood({ text: '', mood: moodText, intensity: rawIntensity }, previous);
      summaries.set(key, next);

      // 先放大新情绪、再按时间衰减（顺序反了会被下限托住，永远散不掉）
      const intensity = next.mood ? effectiveIntensity({ intensity: next.intensity, since: next.since }) : 0;

      let point = null;
      let merged = false;
      // 只有"模型这轮真的给了新情绪"才写历史点；
      // 沿用的情绪只影响下一轮语气，不该当成新事件记一笔。
      if (freshMood && next.mood) {
        const r = pushPoint(key, next.mood, intensity);
        point = r.point;
        merged = r.merged;
      }

      return {
        mood: next.mood ?? '',
        intensity,
        label: intensityLabel(intensity),
        carried: Number(next.carried) || 0,
        classification: next.mood ? classifyMood(next.mood).cls : '平静',
        point,
        merged,
      };
    },

    current(sessionKey) {
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
    },

    stats(opts) {
      const w = typeof opts === 'string' ? opts : opts?.window;
      const pick = (win) => {
        if (win === 'hour') return moodDistribution(recentPoints(history, 1));
        if (win === 'day') return moodDistribution(recentPoints(history, 24));
        return moodDistribution(history);
      };
      if (w) return pick(w);
      return { all: pick('all'), day: pick('day'), hour: pick('hour') };
    },

    people(opts = {}) {
      const list = collectPeople({
        memoryDir: opts.memoryDir ?? config.memoryDir,
        chatIds: opts.chatIds ?? [],
      });
      return { nodes: list, summary: relationSummary(list) };
    },

    points() {
      return history.slice(-MAX_POINTS);
    },

    latest() {
      return history.length ? history[history.length - 1] : null;
    },

    save() {
      logger.save();
    },

    get history() {
      return history;
    },

    classes: MOOD_CLASSES,
  };
}
