/**
 * 状态观察 v2：从聊天流水里推断一个人最近的状态。
 *
 * ⚠️ 先说清楚这是什么、不是什么。
 *
 * 这是**行为统计**，不是心理诊断。
 * 它能看出来的只是「最近作息乱了」「话变少了」「情绪词变多了」这类可观测的变化，
 * 推不出「他抑郁了」—— 那个既不准，也不该由一个机器人下结论。
 *
 * 所有输出都用「看起来 / 相比之前 / 值得留意」这种措辞，
 * 不给任何带诊断意味的标签。看到的人自己判断。
 *
 * 六个维度，全部**跟自己的历史基线比**（不是跟别人比）：
 *
 *   ① 作息   —— 几点在线、深夜占比、是不是不太露面了
 *   ② 活跃度 —— 每天条数涨跌
 *   ③ 语言   —— 句子长度、标点密度、表情/图片比例
 *   ④ 情绪   —— 从内容里数负面/消极/正面词（这层最接近"在说什么"）
 *   ⑤ 社交   —— 跟几个人在对话、是不是不太接话了
 *   ⑥ 连贯性 —— 一口气连发多少条
 *
 * 前四个偏"量"，后两个偏"关系"。合起来才看得出状态。
 *
 * ═══════════════════════════════════════════════════════════
 * 【边界：这些数据只给主人看，不拿去跟当事人互动】
 *
 * 2026-11-05 定下的规矩，记在这儿免得以后又想加：
 *
 *   ✅ 面板给主人看 —— 主人要管这摊事，心里有数是合理的
 *   ❌ 不准据此去"关心"当事人
 *
 * 为什么不准：
 *
 *   被人从聊天记录里算出来"状态不好"，然后由机器人决定要不要去关心 ——
 *   这不是关心，是居高临下。当事人没同意被这样分析，
 *   也没人问过 TA 愿不愿意。
 *
 *   结果就成了"我把你扒开看了看，再按我的判断对待你"。
 *   这跟尊重是反着的。
 *
 * 那关心从哪来？—— 从听见，不从分析。
 *
 *   群里有人当场说「今天累死了」→ 顺口接一句「怎么了」  ✅
 *   系统算出 TA 最近负面词涨了  → 跑去关心              ❌
 *
 *   前者是聊天里的自然反应，后者是监视之后的施舍。
 *   真关心就在当场那一句里，不需要提前算。
 *
 * 所以：**别给这个模块加任何"发给当事人"的出口。**
 * 要加关心，加在正常接话的逻辑里（dsh-agents 的临场反应），不是这里。
 * ═══════════════════════════════════════════════════════════
 */

/** 状态观察最少要多少条消息才有意义 */
const MIN_MESSAGES = 30;

/** 基线窗口：最近窗口之外，再往前看多少天 */
const BASELINE_DAYS = 7;

/** 最近窗口 */
const RECENT_DAYS = 3;

// ── 情绪词表 ─────────────────────────────────────
//
// 刻意不做"情感分析模型"，就用词表数数。
// 理由：模型每调一次要钱要时间，而这里只需要一个趋势信号；
// 词表看得见、改得动、出错也好查。
//
// 分三类，因为它们的含义不一样：
//   负面 —— 直接的不高兴（烦、累、难受）
//   消极 —— 不是不高兴，是"没劲"（无聊、算了、没人在）
//   正面 —— 高兴、期待
//
// 注意：词表偏短是故意的。宁可漏，也不要把"烦死了哈哈哈"这种玩梗算成负面。

const NEGATIVE = [
  '烦', '累', '难受', '糟心', '生气', '气死', '恶心', '崩溃', '烦死',
  '不爽', '无语', '受不了', '忍不了', '憋屈', '委屈', '想哭',
  '失眠', '睡不着', '头疼', '胃疼', '生病', '发烧',
  '吵架', '闹掰', '被骂', '骂我',
];

const APATHY = [
  '无聊', '没意思', '没劲', '算了', '随便', '无所谓', '摆烂', '开摆', '躺平',
  '懒得', '不想说话', '退出', '退了', '消失',
  '孤独', '一个人', '没人在', '没人理',
];

const POSITIVE = [
  '开心', '高兴', '哈哈', '笑死', '快乐', '太好了', '不错', '喜欢',
  '好玩', '有意思', '舒服', '幸福', '满足', '期待', '终于', '赢了', '好吃',
  '厉害', '绝了', '可爱', '爱你', '谢谢',
];

/** 数一段文字里出现的情绪词 */
function countWords(text, list) {
  const t = String(text ?? '');
  let n = 0;
  for (const w of list) {
    let idx = 0;
    while ((idx = t.indexOf(w, idx)) !== -1) {
      n += 1;
      idx += w.length;
    }
  }
  return n;
}

// ── 基础工具 ─────────────────────────────────────

const isNight = (ts) => {
  const h = new Date(ts).getHours();
  return h >= 0 && h < 6;
};

/** 一条消息是不是图片/表情占位 */
const isImage = (text) => {
  const t = String(text ?? '').trim();
  return t === '[图片]' || t === '[表情]' || t.includes('[图片]');
};

/** 这条消息是不是在回应别人（带 @ 或 [回复]） */
const isReplying = (text) => /\[回复\]|@/.test(String(text ?? ''));

/** 从文本里抠出被 @ 的人名（粗提，够用） */
function mentioned(text) {
  const out = [];
  const re = /@\s*([^\s@，,。.!！?？\n]{1,20})/g;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) out.push(m[1]);
  return out;
}

// ── 画像 ─────────────────────────────────────────

/**
 * 汇总一批消息的画像。
 * @param {Array<{time:number, text:string}>} msgs 已按时间排序
 */
function profile(msgs) {
  if (msgs.length === 0) return null;

  const n = msgs.length;
  const hours = msgs.map((m) => new Date(m.time).getHours());
  const texts = msgs.map((m) => String(m.text ?? ''));
  const real = texts.filter((t) => !isImage(t));

  const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  const days = new Set(msgs.map((m) => new Date(m.time).toDateString()));

  let neg = 0;
  let apa = 0;
  let pos = 0;
  for (const t of real) {
    neg += countWords(t, NEGATIVE);
    apa += countWords(t, APATHY);
    pos += countWords(t, POSITIVE);
  }
  const realN = real.length || 1;

  const replyCount = texts.filter((t) => isReplying(t)).length;
  const mentionTargets = new Set();
  for (const t of texts) for (const who of mentioned(t)) mentionTargets.add(who);

  // 连发串：间隔 < 2 分钟算同一串（没有别人插话的信息，只能这样近似）
  let maxStreak = 0;
  let streak = 1;
  for (let i = 1; i < n; i += 1) {
    if (msgs[i].time - msgs[i - 1].time <= 120000) streak += 1;
    else {
      maxStreak = Math.max(maxStreak, streak);
      streak = 1;
    }
  }
  maxStreak = Math.max(maxStreak, streak);

  return {
    count: n,
    days: days.size,
    perDay: n / Math.max(1, days.size),
    latestHour: Math.max(...hours),
    nightCount: msgs.filter((m) => isNight(m.time)).length,
    nightRatio: msgs.filter((m) => isNight(m.time)).length / n,
    medianHour: median(hours),
    avgLen: realN ? real.reduce((a, t) => a + t.length, 0) / realN : 0,
    avgPunct: realN ? real.reduce((a, t) => a + (t.match(/[。！？!?…]/g) ?? []).length, 0) / realN : 0,
    imageRatio: texts.filter((t) => isImage(t)).length / n,
    negRate: (neg / realN) * 100,
    apaRate: (apa / realN) * 100,
    posRate: (pos / realN) * 100,
    replyRatio: replyCount / n,
    socialSpread: mentionTargets.size,
    maxStreak,
  };
}

// ── 比较 ─────────────────────────────────────────

/**
 * 跟基线比，算出偏离。
 * @returns {Array<{key:string, group:string, label:string, before:string, after:string, level:'info'|'warn'}>}
 */
function compare(now, base) {
  const out = [];
  if (!now || !base) return out;
  const push = (key, group, label, before, after, level) => out.push({ key, group, label, before, after, level });

  // ── 活跃度 ──
  if (base.perDay > 0) {
    const ratio = now.perDay / base.perDay;
    // 掉到四成以下才算"变少"，但还要看绝对值：
    // 从 200 条/天掉到 54 条/天，比例是掉了，可 54 条仍然是话很多的人 ——
    // 那大概率只是这阵子没那么闲，不该跟"基本不说话了"混为一谈。
    // 所以：要么掉到很低（< 15 条/天），要么比例掉得非常狠（< 0.25）。
    if (ratio < 0.4 && (now.perDay < 15 || ratio < 0.25)) {
      push('volume', '活跃度', '说话变少', Math.round(base.perDay) + ' 条/天', Math.round(now.perDay) + ' 条/天', 'warn');
    } else if (ratio > 2.5) {
      push('volume', '活跃度', '说话变多', Math.round(base.perDay) + ' 条/天', Math.round(now.perDay) + ' 条/天', 'info');
    }
  }

  // ── 作息 ──
  if (now.nightRatio > base.nightRatio + 0.15) {
    push('night', '作息', '夜里说话多了', Math.round(base.nightRatio * 100) + '%', Math.round(now.nightRatio * 100) + '%', 'warn');
  }
  if (now.nightCount > 0 && now.latestHour >= 1 && now.latestHour <= 6 && now.nightRatio > base.nightRatio + 0.15) {
    push('latest', '作息', '凌晨还醒着', base.nightCount ? base.latestHour + ' 点' : '之前没有', now.latestHour + ' 点', 'warn');
  }
  if (base.days >= 5 && now.days <= 1) {
    push('gap', '作息', '不太露面了', base.days + ' 天都在', now.days + ' 天', 'warn');
  }

  // ── 语言 ──
  if (base.avgLen > 0) {
    if (now.avgLen === 0 && now.imageRatio > 0.5) {
      push('len', '语言', '只发图不说话', base.avgLen.toFixed(1) + ' 字', '全是图', 'warn');
    } else if (now.avgLen > 0 && now.avgLen / base.avgLen < 0.65) {
      push('len', '语言', '句子变短', base.avgLen.toFixed(1) + ' 字', now.avgLen.toFixed(1) + ' 字', 'warn');
    }
  }
  if (base.avgPunct > 0.1 && now.avgPunct > 0 && now.avgPunct / base.avgPunct < 0.5) {
    push('punct', '语言', '标点变少', base.avgPunct.toFixed(2), now.avgPunct.toFixed(2), 'info');
  }
  const imgDiff = now.imageRatio - base.imageRatio;
  if (imgDiff < -0.15) {
    push('image', '语言', '不太发图了', Math.round(base.imageRatio * 100) + '%', Math.round(now.imageRatio * 100) + '%', 'info');
  } else if (imgDiff > 0.3) {
    push('image', '语言', '发图变多', Math.round(base.imageRatio * 100) + '%', Math.round(now.imageRatio * 100) + '%', 'info');
  }

  // ── 情绪 ──
  //
  // 两条门槛都得过：
  //   ① 倍数  —— 相对自己涨了多少
  //   ② 绝对密度 —— 涨完到底有多少。这一条是关键：
  //      0.8 → 1.7/百条涨了 2 倍多，但一天也就讲不到 2 次"累"，
  //      那只是正常起伏，不是状态变了。
  //
  // 踩过的坑：mwei 的 0.77 → 1.71 被判成"负面情绪多"，
  // 可同一时段他的正面词从 1.0 涨到 5.1（涨了五倍）——
  // 那是心情在往上走，只看一倍数字就误伤了。
  const NEG_MIN_RATE = 4;   // 负面词至少每百条 4 次，才算真地密集
  const APA_MIN_RATE = 4;   // 消极词同理

  const negJumped = base.negRate > 0.1 ? now.negRate / base.negRate > 2.2 : now.negRate >= 6;
  if (now.negRate >= NEG_MIN_RATE && negJumped) {
    push('neg', '情绪', '负面词变多', base.negRate.toFixed(1) + '/百条', now.negRate.toFixed(1) + '/百条', 'warn');
  }
  const apaJumped = base.apaRate > 0.1 ? now.apaRate / base.apaRate > 2.2 : now.apaRate >= 6;
  if (now.apaRate >= APA_MIN_RATE && apaJumped) {
    push('apa', '情绪', '消极词变多（没劲/算了）', base.apaRate.toFixed(1) + '/百条', now.apaRate.toFixed(1) + '/百条', 'warn');
  }
  // 正面词变少：基数大，但也不能拿"1 次变 0 次"当信号 ——
  // 那只是样本小，不是状态变了。所以要求基线至少每百条 2 次，
  // 且最近样本够厚（>= 30 条）才有资格谈"变少"。
  if (now.count >= 30 && base.posRate >= 2 && now.posRate / base.posRate < 0.5) {
    push('pos', '情绪', '正面词变少', base.posRate.toFixed(1) + '/百条', now.posRate.toFixed(1) + '/百条', 'warn');
  }
  // 正面词**明显变多**是反证：说明人是在往上走的。
  // 有这条就不该再给人贴情绪类的负面标签。
  if (base.posRate > 0 && now.posRate / base.posRate >= 1.8) {
    push('pos-up', '情绪', '正面词变多', base.posRate.toFixed(1) + '/百条', now.posRate.toFixed(1) + '/百条', 'info');
  }

  // ── 社交 ──
  if (base.socialSpread >= 3 && now.socialSpread <= 1) {
    push('social', '社交', '只跟一两个人说话', '涉及 ' + base.socialSpread + ' 人', now.socialSpread + ' 人', 'warn');
  }
  if (base.replyRatio > 0.15 && now.replyRatio < base.replyRatio * 0.5) {
    push('reply', '社交', '不太接别人的话', Math.round(base.replyRatio * 100) + '%', Math.round(now.replyRatio * 100) + '%', 'warn');
  }

  // ── 连贯性 ──
  if (base.maxStreak >= 3 && now.maxStreak >= Math.max(8, base.maxStreak * 2)) {
    push('streak', '连贯性', '一口气连发很多条', '最长 ' + base.maxStreak + ' 条', '最长 ' + now.maxStreak + ' 条', 'info');
  }

  return out;
}

// ── 对外接口 ─────────────────────────────────────

/**
 * 给一个人算状态。
 *
 * @param {Array<{senderId:string, time:number, text:string}>} records
 * @param {string} userId
 * @param {{now?: number|(() => number), windowMs?: number, baselineMs?: number}} options
 */
export function observeState(records, userId, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Number(options.now) || Date.now();
  const windowMs = options.windowMs ?? RECENT_DAYS * 24 * 60 * 60 * 1000;
  const baselineMs = options.baselineMs ?? BASELINE_DAYS * 24 * 60 * 60 * 1000;

  const mine = (records ?? [])
    .filter((r) => String(r.senderId ?? '') === String(userId))
    .filter((r) => Number(r.time) > 0)
    .sort((a, b) => a.time - b.time);

  const recentRaw = mine.filter((r) => r.time >= now - windowMs);
  const baseRaw = mine.filter((r) => r.time < now - windowMs && r.time >= now - windowMs - baselineMs);

  const recent = profile(recentRaw);
  const baseline = profile(baseRaw);
  const signals = compare(recent, baseline);

  // 样本够不够，分两种情况：
  //   有基线 —— 基线够厚就能比（最近哪怕只剩几条，正是「变少」该被看见的时候）
  //   没基线 —— 只能看最近本身够不够厚
  const recentN = recent?.count ?? 0;
  const baseN = baseline?.count ?? 0;
  const hasEnough = baseN > 0 ? baseN >= MIN_MESSAGES : recentN >= MIN_MESSAGES;

  let note = '';
  if (!recent) {
    note = '最近没说话';
  } else if (!hasEnough) {
    note = '样本还太少（最近 ' + recentN + ' 条 / 之前 ' + baseN + ' 条），先记着';
  } else if (!baseline) {
    note = '还没有历史基线，过几天才能比';
  } else if (!signals.length) {
    note = '跟平时差不多';
  } else {
    const warns = signals.filter((s) => s.level === 'warn');
    note = warns.length
      ? '有几处跟平时不一样：' + warns.map((s) => s.label).join('、')
      : '有点变化：' + signals.map((s) => s.label).join('、');
  }

  return { userId: String(userId), hasEnough, recent, baseline, signals, note };
}

/**
 * 每种信号「有多值得看一眼」的权重。
 *
 * 为什么需要：光数 warn 的条数没用 ——
 * 一个人「负能量爆棚 + 只发图不说话 + 消失了」和另一个人「正面词少了一点」，
 * warn 数可能都是 1，但完全不是一回事。
 *
 * 分档：
 *   100+  可能真出事了（情绪急转、彻底消失、完全不接话）
 *    70   明显不对劲（负面/消极词涨、说话骤减、凌晨还醒着）
 *    40   有变化但可能只是波动（句子变短、标点、发图习惯）
 */
const SIGNAL_WEIGHT = {
  neg: 100,      // 负面词突然变多
  apa: 95,       // 消极词变多（没劲/算了/没人理）
  gap: 90,       // 不太露面了
  social: 85,    // 只跟一两个人说话
  reply: 80,     // 不太接别人的话了
  volume: 75,    // 说话骤减
  latest: 70,    // 凌晨还醒着
  night: 65,     // 夜里说话变多
  pos: 60,       // 正面词变少
  len: 55,       // 句子变短
  image: 40,     // 发图习惯变化
  punct: 30,     // 标点变少
  streak: 25,    // 一口气连发
};

/** 取一个信号的权重，没配的给个中间值 */
function weightOf(key) {
  return SIGNAL_WEIGHT[key] ?? 50;
}

/**
 * 给一个人算「严重度」。
 *
 * 同一维度只取最高分，不做简单相加 ——
 * 否则"情绪类三个词都涨了"会把一个人顶到天上，而那其实是同一件事。
 */
export function severityOf(signals) {
  const warns = (signals ?? []).filter((s) => s.level === 'warn');
  if (!warns.length) return 0;
  const byGroup = new Map();
  for (const s of warns) {
    const g = s.group || '其它';
    byGroup.set(g, Math.max(byGroup.get(g) ?? 0, weightOf(s.key)));
  }
  return [...byGroup.values()].reduce((a, b) => a + b, 0);
}

/**
 * 根据信号组合贴"可能是怎么回事"的标签。
 *
 * ⚠️ 这些是**猜测**，不是诊断。语言上刻意留了余地（"可能""像是"），
 * 而且刻意不出现任何病名 —— 从聊天统计里推不出那种东西，写上去就是编。
 *
 * 每条规则看的是"哪几种变化同时出现"，因为单看一条几乎定了不了什么：
 *   只说话变少     → 大概率就是忙
 *   说话变少 + 夜猫子 + 负面词涨 → 像是被什么事占了心思
 *
 * @param {Array<{key:string, group:string, level:string}>} signals
 * @returns {Array<{text:string, tone:'calm'|'warm'|'hot'}>}
 */
export function inferTags(signals) {
  const warns = new Set((signals ?? []).filter((s) => s.level === 'warn').map((s) => s.key));
  const has = (...keys) => keys.some((k) => warns.has(k));
  const count = (...keys) => keys.filter((k) => warns.has(k)).length;

  // 正向反证：正面词明显变多，说明人是在往上的方向走。
  // 这种情况下就不要再贴"心里有事/有压力/提不起劲"这类负面标签 ——
  // 之前 mwei 就是负面词翻倍被判异常，其实同一时段正面词涨了五倍。
  const rising = new Set((signals ?? []).filter((s) => s.level === 'info').map((s) => s.key)).has('pos-up');
  const moodUp = rising && !has('pos', 'apa');

  const tags = [];

  // ── 可能只是在忙 ──
  // 只少说话、没别的负面信号：最常见也最无害。
  if (has('volume') && !has('neg', 'apa', 'pos', 'gap', 'social', 'reply') && !has('len')) {
    tags.push({ key: 'quiet', text: '只在说话量上有变化', tone: 'calm' });
  }
  // 说话少 + 句子短，但没有负面词：像是"顺手回两句"的状态
  if (has('volume', 'gap') && has('len') && !has('neg', 'apa', 'pos')) {
    tags.push({ key: 'no-time', text: '像是没空闲聊', tone: 'calm' });
  }
  // 只在深夜冒泡，白天不见人：作息偏了，但未必有事
  if (has('night', 'latest') && !has('neg', 'apa')) {
    tags.push({ key: 'night-owl', text: '作息偏夜猫', tone: 'calm' });
  }

  // ── 像是心里有事 ──
  // 负面词涨 + 社交收缩：这两条一起出现才更像"不太想说话"
  if (has('neg', 'apa') && has('social', 'reply') && !moodUp) {
    tags.push({ key: 'multi', text: '多处跟平时不一样', tone: 'hot' });
  }
  // 只负面词涨、社交没变：可能只是最近遇到糟心事，或者群里气氛就紧
  if (has('neg', 'apa') && !has('social', 'reply', 'gap') && !moodUp) {
    tags.push({ key: 'heavy-words', text: '用词比以前重', tone: 'warm' });
  }
  // 正面词涨 + 话变多：情绪是往上的方向
  if (has('pos') && has('volume') && !has('neg', 'apa')) {
    tags.push({ key: 'chatty', text: '比平时话多些', tone: 'calm' });
  }
  // （"只说话变少"那一种上面已经处理过，这里不再重复加，免得同一句贴两遍）
  // 正面词明显变少 + 少说话：情绪底色变了
  if (has('pos') && has('volume', 'len', 'gap')) {
    tags.push({ key: 'words-changed', text: '用词跟平时不同', tone: 'warm' });
  }
  // 消极词涨（没劲/算了/没人理）：那种"提不起劲"的状态
  if (has('apa') && has('volume', 'social', 'reply', 'len')) {
    tags.push({ key: 'less-reply', text: '主动接话少了', tone: 'warm' });
  }
  // 彻底不露面 + 之前很活跃
  if (has('gap') && has('social', 'reply')) {
    tags.push({ key: 'withdrawn', text: '参与度明显降低', tone: 'hot' });
  }
  // 夜里话多 + 负面词：半夜容易想多，这条要轻一点说
  if (has('night', 'latest') && has('neg', 'apa', 'pos')) {
    tags.push({ key: 'late-hours', text: '活动时间后移', tone: 'warm' });
  }

  // ── 压力 / 累 ──
  //
  // "压力大"没法直接测，但痕迹固定：话变少变短、负面词多、作息往后拖。
  //
  // 门槛比一开始设的松：原来要求必须有 night/latest（深夜信号），
  // 但那两个很少触发（得凌晨还在说话才算），结果一条都命中不了。
  // 实际起作用的是前三样，作息只是加分项。
  const stressCore = count('volume', 'len', 'neg', 'apa');
  const stressBody = count('night', 'latest', 'punct', 'social', 'gap');
  if (stressCore >= 2 && has('neg', 'apa') && stressBody >= 1 && !moodUp) {
    tags.push({ key: 'many-shifts', text: '多项指标同时变化', tone: 'hot' });
  }
  // 说话变少变短、但负面词没涨：可能是累，不是不高兴
  if (has('volume') && has('len') && !has('neg', 'apa')) {
    tags.push({ key: 'short-quiet', text: '话少且句子短', tone: 'warm' });
  }
  // 白天不见人、只在深夜冒头
  if (has('night', 'latest') && has('volume') && !has('neg', 'apa')) {
    tags.push({ key: 'only-night', text: '白天基本见不到人', tone: 'warm' });
  }
  // 句子变短 + 话变少，但生活气息还在（没有负面词）
  if (has('len') && has('volume') && !has('neg', 'apa', 'pos')) {
    tags.push({ key: 'brief', text: '回话变简短了', tone: 'calm' });
  }
  // 标点都没了：那种"懒得打完整句子"的状态
  if (has('punct') && has('len', 'volume')) {
    tags.push({ key: 'no-punct', text: '懒得打标点了', tone: 'calm' });
  }

  // ── 别的方向 ──
  // 连发很多条 + 说话变多：可能是兴奋，也可能是憋着想说
  if (has('streak') && has('volume')) {
    tags.push({ key: 'dense', text: '话比平时密', tone: 'calm' });
  }
  // 只发图不说话
  if (has('len')) {
    const onlyImages = (signals ?? []).some((s) => s.key === 'len' && s.level === 'warn');
    if (onlyImages && warns.has('image')) tags.push({ key: 'images-only', text: '光发图不吭声', tone: 'warm' });
  }

  // 先去重，再按语气排序，最后截三个。
  //
  // 顺序很重要：原来只做去重再截前三个，结果"可能只是忙"这种排在前面
  // 会把后面加的"最近像是有压力"挤掉 —— 越严重的反而看不到。
  // 现在 hot 先出、calm 垫后。
  const toneRank = { hot: 0, warm: 1, calm: 2 };
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    if (seen.has(t.text)) continue;
    seen.add(t.text);
    out.push(t);
  }
  out.sort((a, b) => (toneRank[a.tone] ?? 9) - (toneRank[b.tone] ?? 9));
  return out.slice(0, 3);
}

/**
 * 按群分开算「值得看一眼」的人。
 *
 * 为什么必须分开：同一个号在两个群里能判出完全不同的状态 ——
 * 在一个群很活跃、在另一个群基本不说话，混在一起算两边都被稀释，
 * 结果是谁都不像有变化。记录里的 key（group:xxx）用来区分群。
 *
 * @param {Array<{key?:string, senderId:string, senderName:string, time:number, text:string}>} records
 * @param {{now?: number|(() => number), limit?: number, groupKey?: string}} options
 * @returns {{groups: Array<{key:string, people: Array}>}}
 *
 * 返回的东西**只给面板用**。别拿去找当事人说话 ——
 * 见文件头「边界」那段：从数据推出来的关心，是不尊重人的。
 */
export function findNotableByGroup(records, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Number(options.now) || Date.now();
  const raw = Number(options.limit);
  const limit = Number.isFinite(raw) && raw > 0 ? raw : Infinity;

  const buckets = new Map();
  for (const r of records ?? []) {
    const key = String(r.key ?? '') || 'unknown';
    if (options.groupKey && key !== options.groupKey) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }

  const groups = [];
  for (const [key, list] of buckets) {
    // 一个群一个人都没有也照样列出来 —— 前端才知道"这个群很平静"
    groups.push({ key, people: findNotable(list, { now, limit }) });
  }

  // 人多的群排前面，平静的垫底
  groups.sort((a, b) => b.people.length - a.people.length || a.key.localeCompare(b.key));
  return { groups };
}

/**
 * 从一批流水里挑出「值得看一眼」的人（不分群，给 findNotableByGroup 内部用）。
 *
 * @param {Array<{senderId:string, senderName:string, time:number, text:string}>} records
 * @param {{now?: number|(() => number), limit?: number}} options
 */
export function findNotable(records, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Number(options.now) || Date.now();
  // limit <= 0 表示不限制 —— 多一个人有信号就多一条，不悄悄截断
  const raw = Number(options.limit);
  const limit = Number.isFinite(raw) && raw > 0 ? raw : Infinity;

  const ids = new Set((records ?? []).map((r) => String(r.senderId ?? '')).filter(Boolean));
  const nameOf = new Map();
  for (const r of records ?? []) {
    nameOf.set(String(r.senderId ?? ''), String(r.senderName ?? ''));
  }

  const rows = [];
  for (const id of ids) {
    const state = observeState(records, id, { now });
    if (!state.hasEnough) continue;
    const warns = state.signals.filter((s) => s.level === 'warn');
    if (!warns.length) continue;
    const name = nameOf.get(id) || id;
    // 按严重度排：不是数 warn 的条数，而是看每一条"有多值得看"
    const severity = severityOf(state.signals);
    // 猜一下"可能是怎么回事"——只是猜测，措辞留了余地
    const tags = inferTags(state.signals);
    rows.push({ id, name, warns: warns.length, severity, tags, state });
  }

  return rows.sort((a, b) => b.severity - a.severity || b.warns - a.warns).slice(0, limit);
}

export const STATE_LIMITS = { MIN_MESSAGES, BASELINE_DAYS, RECENT_DAYS };

/** 给测试用的内部函数 */
export const __internal = { profile, compare, countWords, mentioned, isReplying, NEGATIVE, APATHY, POSITIVE, isImage, isNight };
