/**
 * 粗糙的极性估计：把一句情绪文本压到 -1..1。
 *
 * 只给"分类兜底"和面板曲线用，**不是**给模型看的判据 —— 词表永远估不准，
 * 真正有分量的是模型给的强度。
 */

/** 正面词 */
export const POSITIVE_WORDS = [
  '开心', '高兴', '美滋滋', '爽', '乐', '笑', '想接', '有精神', '来劲', '得意',
  '舒服', '喜欢', '感动', '暖和', '暖', '好奇', '好玩',
];

/** 负面词 */
export const NEGATIVE_WORDS = [
  '不爽', '烦', '气', '懵', '没兴趣', '不想', '无语', '难受', '委屈', '敷衍',
  '膈应', '烦人', '累了', '困', '下头', '无聊', '没劲', '懒得',
];

/**
 * 情绪文本 → -1..1 的极性。
 * @param {string} mood
 * @returns {number}
 */
export function polarityOf(mood) {
  const text = String(mood ?? '');
  if (!text.trim()) return 0;
  let score = 0;
  for (const w of POSITIVE_WORDS) if (text.includes(w)) score += 1;
  for (const w of NEGATIVE_WORDS) if (text.includes(w)) score -= 1;
  // 否定词打个折：句子里有"不"时把正面信号减半（"不想接"已经算负面词了，这层是兜底）
  if (/不|没|别/.test(text) && score > 0) score -= 0.5;
  // 压到 -1..1
  return Math.max(-1, Math.min(1, score / 2));
}
