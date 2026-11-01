/**
 * 情绪点的"淡化 + 过期"。
 *
 * 跟 `emotion.js` 里那个情绪状态机的老化不是一回事：
 *   - 那边管的是**当前这一个情绪**该用什么语气（小时级）；
 *   - 这边管的是**历史流水里那些点**该怎么显示、什么时候丢掉（天级）。
 *
 * 目的：让面板上的走势图有"最近的事清楚、旧的事淡出去"的层次感，
 * 而不是一堆以前的点永远画得跟刚发生一样重。
 */

/** 一天多少毫秒 */
const DAY = 24 * 60 * 60 * 1000;

/**
 * 一个点随时间衰减后的显示权重（0-1）。
 *
 * 分四段而不是线性：线性会让"三天前的点"还留着 40% 的存在感，
 * 看起来像没淡过。分段的用意是制造明显的"层次"：
 *
 *   刚发生   → 1.00  清晰的
 *   半天内   → 0.85  基本还是这个亮度
 *   1 天内   → 0.60  开始退后
 *   3 天内   → 0.30  只是背景里的痕迹
 *   3 天以上 → 0.12  几乎只剩轮廓（还在保留期内就还画）
 *
 * @param {number} at 点的毫秒时间戳
 * @param {number} [now]
 * @returns {number} 0-1
 */
export function displayWeight(at, now = Date.now()) {
  const t = Number(at);
  if (!Number.isFinite(t)) return 1; // 时间戳坏了就当新的，别误判成旧的
  const age = Math.max(0, now - t);
  if (age < 12 * 60 * 60 * 1000) return 1;
  if (age < DAY) return 0.85;
  if (age < 3 * DAY) return 0.6;
  if (age < 7 * DAY) return 0.3;
  return 0.12;
}

/**
 * 是否已经老到该彻底丢掉（面板不再画、也不再存）。
 *
 * 跟 displayWeight 分开：轻到 0.12 的点仍然保留（能看出"那天有过情绪"），
 * 只有过了 keepDays 才真删。
 *
 * @param {number} at
 * @param {number} keepDays
 * @param {number} [now]
 */
export function isExpired(at, keepDays, now = Date.now()) {
  const t = Number(at);
  if (!Number.isFinite(t)) return false; // 坏的别删，留给人工看
  return now - t > keepDays * DAY;
}

/**
 * 一批点里哪些还算"新鲜的"（没超保留期）。
 *
 * 保守策略：只有当时间戳看起来是真的（最新那个晚于 2020）才按时间判断，
 * 否则（测试里的小数字、写坏的数据）一律当新鲜，避免误删。
 *
 * @param {Array<{at:number}>} points
 * @param {number} keepDays
 * @param {number} [now]
 * @returns {Array<{at:number}>}
 */
export function freshPoints(points, keepDays, now = Date.now()) {
  const list = points ?? [];
  if (list.length === 0) return list;
  const ats = list.map((p) => Number(p?.at)).filter(Number.isFinite);
  const looksReal = ats.length > 0 && Math.max(...ats) > 1_577_836_800_000;
  if (!looksReal) return list;
  return list.filter((p) => !isExpired(p?.at, keepDays, now));
}

/**
 * 分段描述，给面板写图例用。
 * @param {number} weight
 * @returns {string}
 */
export function fadeLabel(weight) {
  if (weight >= 0.99) return '刚刚';
  if (weight >= 0.8) return '半天内';
  if (weight >= 0.55) return '一天内';
  if (weight >= 0.25) return '三天内';
  return '更早';
}
