/**
 * 关系星图：把群记忆里的"人"抽成节点，给面板画一张"她跟谁什么关系"的图。
 *
 * 数据来源就是群记忆的人名条目，不额外存东西 —— 记忆改了图就跟着变。
 *
 * 每个节点算三样：
 *   - relation：owner / admin / friend / stranger（跟 memory.js 同一套判定）
 *   - weight：联系强度 0-1，按"记忆里写了他多少"估算（写得越多 = 接触越多）
 *   - warmth：亲近度 0-1，主人拉满，熟人中等，陌生偏低
 */
import fs from 'node:fs';
import path from 'node:path';
import { relationshipOf } from './memory.js';

/**
 * 群记忆里用同样的 `- **xxx**：` 写法记录的非人名条目。
 *
 * 这些是"群氛围""风格""其它""待补充"之类的描述段落，不是人。
 * 但它们常会提到"主人"，如果不过滤就会被 relationshipOf 判成 owner，画出一堆假节点。
 */
const NON_PERSON_LABELS = new Set([
  '风格', '其它', '其他', '气氛', '氛围', '待补充', '备注', '说明', '总结', '总纲',
  '群文化', '群规', '规矩', '约定', '黑话', '梗', '背景', '简介', '注意', '提示',
]);

/**
 * 判断一个"名字"像不像真人昵称。
 *
 * 真人昵称就是群里那串字符；而记忆里拿列表写法记的**事件/梗/约定**长这样：
 *   "和老友乙的「追不上」梗" / "今天开黑吗" / "别换个不认得我的"
 * 它们的共同点：带书名号/引号、带"和…的""…梗""…的事"这类结构、或整体偏长。
 *
 * 保守起见只在"明显不像昵称"时排除，别把带符号的正常昵称（群友戊）误杀。
 * @param {string} name
 */
/** 关系强弱排序：合并同一人时取更强的那个。 */
const REL_RANK = { stranger: 0, friend: 1, admin: 2, owner: 3 };
function relationRank(rel) {
  return REL_RANK[rel] ?? 0;
}

function looksLikePersonName(name) {
  if (!name) return false;
  // 明显是描述段落：带书名号/引号 + 结构词
  if (/[「」『』“”"]/.test(name) && /的|梗|事|话|句/.test(name)) return false;
  // "和 X 的 …" / "关于 …"：一定是在描述关系或事件，不是昵称本身
  if (/^(和|跟|关于|与).+的/.test(name)) return false;
  // 太长（真人昵称很少超过 12 个字；超了基本是句子）
  if (name.length > 14) return false;
  return true;
}

/**
 * 从群记忆里抽人名节点。
 * @param {{ memoryDir?: string, chatIds?: string[], warn?: (m: string) => void }} options
 * @returns {Array<{ id: string, name: string, relation: string, weight: number, warmth: number, note: string, group: string, x?: number, y?: number }>}
 */
export function collectPeople(options = {}) {
  const { memoryDir, chatIds = [], warn } = options;
  /** @type {Array<{id:string,name:string,relation:string,weight:number,warmth:number,note:string,group:string}>} */
  const out = [];

  for (const chatId of chatIds) {
    const file = memoryDir ? path.join(memoryDir, `${chatId}.md`) : '';
    if (!file) continue;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // 没有这个群的记忆很正常
    }

    // 同一个文件里，同一个人可能写了两条（老档案 openid 版 + 新档案 QQ 号版）。
    // 跨群合并靠下面按 id 找已存在节点；这里只处理同文件内的同名重复。
    const seenNames = new Set();

    for (const line of text.split(/\r?\n/)) {
      if (!/^\s*[-*]\s+\*\*/.test(line)) continue;
      // 两种写法都要认：
      //   - **昵称（QQ 123456）**：描述        ← 号在星号里面
      //   - **昵称**（旧 openid `ABC...`）：描述  ← 号在星号外面（老档案）
      const m = line.match(/^\s*[-*]\s+\*\*(.+?)\*\*\s*([:：]?)\s*(.*)$/);
      if (!m) continue;
      const head = m[1];
      const tail = m[3] ?? '';
      // 号可能出现在 head（星号内）也可能出现在 tail（星号后的括号里）
      const both = `${head} ${tail}`;
      const note = tail;

      // 先抠 openid，再从"去掉 openid 之后的文本"里找 QQ 号 ——
      // 否则 /\d{5,}/ 会把 openid 里的数字片段（比如 BA415338... 里的 415338）当成 QQ 号。
      const openid = both.match(/[0-9A-Fa-f]{32}/)?.[0] || '';
      const withoutOpenid = openid ? both.split(openid).join(' ') : both;
      const ids = withoutOpenid.match(/\d{5,}/g) ?? [];

      // 名字：星号内的纯名字（去掉可能带的括号）
      const name = head.replace(/[（(][^）)]*[）)]/g, '').replace(/`/g, '').trim();
      // 纯数字名（"06661(06661)"）大多是占位，跳过；其他名字一律保留
      if (!name || /^\d+$/.test(name)) continue;

      // 排除"不是人"的条目：群记忆里除了人名，还常用同样的列表写法记
      // 「风格」「其它」「气氛」这类描述段落。它们提到"主人"就会被误判成 owner。
      // 两道判据：① 已知的非人名标签；② 明显像句子/梗名的（"和某某的「某某」梗"）。
      if (NON_PERSON_LABELS.has(name.toLowerCase())) continue;
      if (!looksLikePersonName(name)) continue;

      // 号可能有也可能没有：早期群档案（比如第二个群）只写了名字没写号。
      // 没号时用名字当标识 —— 反正记忆本身就靠名字认人，图上也只需要一个唯一键。
      const id = ids[0] || openid || `name:${name.toLowerCase()}`;

      const relation = relationshipOf(text, id);

      // 按"人"合并：同一个人只画一个节点，群归属记进 groups。
      // 两种合并都做：
      //   ① 同一个号/openid（主人那种跨群重复）
      //   ② 同一个名字（老档案 openid 一条 + 新档案 QQ 号一条，比如老友乙、老友丙）
      const nameKey = name.toLowerCase();
      const existing = out.find((x) => x.id === id || x.name.toLowerCase() === nameKey || x.id === `name:${nameKey}`);
      if (existing) {
        if (!existing.groups.includes(chatId)) existing.groups.push(chatId);
        // 有真号就升级 id（比 name:xxx 更准）
        if (!existing.id.includes(':') && !id.includes(':')) {
          // 两边都是号：优先留数字号
          if (/^\d+$/.test(id) && !/^\d+$/.test(existing.id)) existing.id = id;
        } else if (existing.id.startsWith('name:') && !id.startsWith('name:')) {
          existing.id = id;
        }
        // 描述取更长的那个（信息更多）
        if (note.length > existing.note.length) existing.note = note.slice(0, 80);
        // 关系取更强的
        const better = relationRank(relation) > relationRank(existing.relation) ? relation : existing.relation;
        existing.relation = better;
        existing.warmth = Math.max(existing.warmth, warmthOf(better, note));
        existing.weight = Math.max(existing.weight, weightOf(note));
        continue;
      }

      out.push({
        id,
        name,
        relation,
        weight: weightOf(note),
        warmth: warmthOf(relation, note),
        note: note.slice(0, 80),
        group: chatId,
        groups: [chatId],
      });
    }
  }

  // 强联系的排前面
  out.sort((a, b) => b.warmth - a.warmth || b.weight - a.weight);

  // 力导向布局需要的初始位置：按圆环均匀铺开，再让前端去迭代。
  // 放在服务端算好初值，前端就不用担心随机抖动导致同一份数据画出不同形状。
  const n = out.length;
  for (let i = 0; i < n; i += 1) {
    const a = (Math.PI * 2 * i) / Math.max(1, n) - Math.PI / 2;
    out[i].x = Math.cos(a);
    out[i].y = Math.sin(a);
  }
  return out;
}

/** 联系强度：记忆里写得多 = 接触多。1 行满，200 字封顶。 */
function weightOf(note) {
  const len = String(note ?? '').length;
  return Math.min(1, 0.25 + len / 200);
}

/** 亲近度：主人拉满，熟人中等，陌生人低。 */
function warmthOf(relation, note) {
  const base = relation === 'owner' ? 1 : relation === 'admin' ? 0.7 : relation === 'friend' ? 0.5 : 0.2;
  // 记忆里写了"熟/喜欢/抱/暖"这类，再加一点
  const bonus = /熟|喜欢|抱|暖|亲|贴/.test(note) ? 0.1 : 0;
  return Math.min(1, base + bonus);
}

/**
 * 关系分布：按 relation 统计**人**数（不是节点数），给面板画比例用。
 *
 * 同一个人出现在两个群会有两个节点，统计时按 id 去重，否则主人会被算成 2 个。
 * @param {Array<{relation:string, id?: string, name?: string}>} people
 */
export function relationSummary(people) {
  const buckets = { owner: 0, admin: 0, friend: 0, stranger: 0 };
  const seenPerson = new Set();
  for (const p of people ?? []) {
    if (!(p?.relation in buckets)) continue;
    // 用 id（有号）/名字（没号）做人的唯一键
    const key = p.id || p.name || '';
    if (key) {
      if (seenPerson.has(key)) continue;
      seenPerson.add(key);
    }
    buckets[p.relation] += 1;
  }
  return buckets;
}
