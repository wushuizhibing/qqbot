/**
 * 情绪分类：把一句自由文本的 mood 归到几个大类，给面板的"情绪星图"用。
 *
 * 为什么用分类而不是直接看原文：原文每条都不一样（"被当成啃零食的""名字被开玩笑"），
 * 没法统计比例。归类成固定几维才能画雷达图、算占比。
 *
 * 维度取自真实群聊里会出现的情绪，不是心理学量表：
 *   开心 / 好奇 / 烦 / 亲近 / 疲惫 / 得意 / 尴尬
 * 外加一个"平静"（mood 为空时计入），因为它是最常见的状态。
 */
import { polarityOf } from './panel.js';

/** @typedef {'开心'|'好奇'|'烦'|'亲近'|'疲惫'|'得意'|'尴尬'|'平静'} MoodClass */

export const MOOD_CLASSES = ['开心', '好奇', '烦', '亲近', '疲惫', '得意', '尴尬', '平静'];

/** 每个类别的关键词表（命中越具体越靠前）。 */
const KEYWORDS = {
  开心: ['爽', '好笑', '笑死', '乐', '开心', '高兴', '美滋滋', '逗', '有意思', '来劲', '来精神', '带劲', '好玩', '想玩', '开森', '起劲', '精神', '想接', '提神'],
  好奇: ['好奇', '想知道', '想看看', '什么', '为啥', '咋回事', '有意思', '新鲜', '没懂', '懵', '疑惑', '想看'],
  // 注意：不要放单字"气" —— 会误命中"松了口气"；只用双字以上、语义明确的词。
  // 也不能放单字"烦" —— "没劲"里含"烦"的反义字没有，但"烦"会命中"烦死"以外的组合，保留双字即可。
  烦: ['很不爽', '不爽', '生气', '来气', '无语', '不想理', '无聊', '敷衍', '膈应', '烦人', '恼', '烦死', '烦躁', '烦'],
  亲近: ['喜欢', '亲近', '想贴', '抱', '暖', '感动', '想跟着', '顺眼', '熟', '亲切', '觉得可爱', '亲'],
  // 疲惫：低能量的词都在这里（懒得/没劲/提不起），别跟"烦"混
  疲惫: ['累', '困', '乏', '躺平', '不想动', '提不起', '没力气', '想睡', '倦', '懒得', '没劲', '无精打采'],
  得意: ['得意', '美', '被夸', '自豪', '赢', '厉害', '优越', '有面子', '被认可', '想秀'],
  尴尬: ['尴尬', '心虚', '窘', '出丑', '不好意思', '被拆穿', '社死', '僵', '被点名', '被点'],
};

/** 强度加权：同样一句话，强度 8 比强度 2 更应该算"真的发生了" */
function weightOf(intensity) {
  const n = Math.max(0, Math.min(10, Number(intensity) || 0));
  // 1 分也算数，但权重低；6 以上明显加权
  return 0.4 + (n / 10) * 1.2;
}

/**
 * 否定词 / 反义处理：在关键词匹配前先把容易误判的组合替换掉。
 *
 * 踩过的坑：
 *   - "松了口气" 里的"气"被当成生气 → 换成"放松"
 *   - "不爽" 里的"爽"被当成开心 → 换成"烦"
 *   - "懒得动""没劲"被当成烦 → 它们其实是疲惫，交给疲惫的关键词去命中
 */
const NEGATIONS = [
  [/松了口气|松口气|松一口气/g, '放松'],
  // "提不起劲/提不起精神" 里的"起劲/精神"会被当成开心 —— 先整体替换成疲惫词
  [/提不起劲|提不起精神|提不起兴致/g, '疲惫没力气'],
  [/不开心|不高兴|不爽|不舒服|不痛快/g, '烦'],
  [/不好笑|没笑点/g, '烦'],
];

/**
 * 把一条情绪文本归类。
 * @param {string} mood
 * @returns {{ cls: MoodClass, hits: string[] }}
 */
export function classifyMood(mood) {
  const raw = String(mood ?? '').trim();
  if (!raw) return { cls: '平静', hits: [] };
  // 先做否定处理，再匹配 —— 否则"不爽"会命中"爽"
  let text = raw;
  for (const [re, to] of NEGATIONS) text = text.replace(re, ` ${to} `);

  let best = null;
  for (const [cls, words] of Object.entries(KEYWORDS)) {
    const hits = words.filter((w) => text.includes(w));
    if (hits.length && (!best || hits.length > best.hits.length)) best = { cls, hits };
  }
  // 关键词一个都没中：用极性兜底 —— 负面算烦，正面算开心，中性算平静
  if (!best) {
    const p = polarityOf(text);
    if (p < -0.15) return { cls: '烦', hits: [] };
    if (p > 0.15) return { cls: '开心', hits: [] };
    return { cls: '平静', hits: [] };
  }
  return best;
}

/**
 * 统计一批情绪点的各类占比。
 *
 * 用加权计数：强度高的点权重更大，"平静"（强度 0）也参与分母，
 * 这样占比能反映"它大多数时候其实没情绪"。
 *
 * @param {Array<{ mood?: string, intensity?: number }>} points
 * @returns {{ total: number, counts: Record<string, number>, ratio: Record<string, number> }}
 */
export function moodDistribution(points) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const cls of MOOD_CLASSES) counts[cls] = 0;
  let total = 0;

  for (const p of points ?? []) {
    const { cls } = classifyMood(p?.mood);
    const w = weightOf(p?.intensity);
    counts[cls] = (counts[cls] ?? 0) + w;
    total += w;
  }

  /** @type {Record<string, number>} */
  const ratio = {};
  for (const cls of MOOD_CLASSES) {
    ratio[cls] = total > 0 ? counts[cls] / total : 0;
  }
  return { total, counts, ratio };
}

/**
 * 只取最近一段时间内的点（星图默认看"最近的它"）。
 * @param {Array<{ at: number }>} points
 * @param {number} hours
 * @param {number} [now]
 */
export function recentPoints(points, hours, now = Date.now()) {
  const cutoff = now - hours * 60 * 60 * 1000;
  return (points ?? []).filter((p) => Number(p?.at) >= cutoff);
}
