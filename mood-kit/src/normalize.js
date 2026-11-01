/**
 * 情绪值的规整原语。
 *
 * 从 qq-kit 的 bridge.js 抽出来，让"情绪"这套逻辑不再依赖具体聊天插件的实现。
 * 任何插件都能用这几个函数把模型/规则给的脏数据洗成可用的强度值。
 */

/** 情绪字段的最大长度：一句话，塞进 prompt 不占地方 */
export const MOOD_MAX = 60;

/** 强度上限；超过按上限算，脏数据归零 */
export const MOOD_INTENSITY_MAX = 10;

/**
 * 值 → 0-10 整数强度。字符串数字也认；认不出来当 0。
 * @param {unknown} raw
 * @returns {number}
 */
export function normalizeIntensity(raw) {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MOOD_INTENSITY_MAX, Math.round(n)));
}

/**
 * 规整情绪文本：单行、去引号、限长。脏数据一律当没有。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeMood(raw) {
  // 先去引号再判断"无"：模型常写成「无」/“没有”
  const text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[「『"'（(\[]+|[」』"'）)\]]+$/g, '')
    .trim();
  // 模型偶尔会把"没情绪"写成这些，别当成情绪带进 prompt
  if (/^(无|没有|没事|平静|正常|neutral|none|null|n\/a|-{1,2})$/i.test(text)) return '';
  return text.slice(0, MOOD_MAX);
}
