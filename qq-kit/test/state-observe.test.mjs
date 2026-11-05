import test from 'node:test';
import assert from 'node:assert/strict';

import { observeState, findNotable, STATE_LIMITS } from '../src/state-observe.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// 固定「现在」，免得测试在半夜跑出不同结果
const NOW = new Date('2026-11-04T20:00:00+08:00').getTime();

/** 造一条消息 */
function msg(id, time, text = '随便说句话') {
  return { senderId: id, senderName: 'u' + id, time, text };
}

/** 造一个人在某天的若干条消息（指定小时） */
function dayMsgs(id, dayOffset, hour, count, text = '今天打了把游戏还挺开心的') {
  const base = NOW - dayOffset * DAY;
  const d = new Date(base);
  d.setHours(hour, 0, 0, 0);
  return Array.from({ length: count }, (_, i) => msg(id, d.getTime() + i * 60000, text));
}

test('样本太少时不下结论', () => {
  const records = [msg('1', NOW - HOUR), msg('1', NOW - 2 * HOUR)];
  const s = observeState(records, '1', { now: NOW });
  assert.equal(s.hasEnough, false);
  assert.match(s.note, /太少/);
});

test('没说过话的人返回空', () => {
  const s = observeState([msg('2', NOW - HOUR)], '1', { now: NOW });
  assert.equal(s.recent, null);
  assert.match(s.note, /没说话/);
});

test('活跃度骤降会被发现', () => {
  const records = [
    // 最近 3 天：一共 6 条
    ...dayMsgs('1', 1, 15, 2),
    ...dayMsgs('1', 2, 15, 2),
    ...dayMsgs('1', 3, 15, 2),
    // 基线（3-10 天前）：每天 30 条
    ...dayMsgs('1', 5, 15, 30),
    ...dayMsgs('1', 6, 15, 30),
    ...dayMsgs('1', 7, 15, 30),
  ];
  const s = observeState(records, '1', { now: NOW });
  assert.equal(s.hasEnough, true);
  const vol = s.signals.find((x) => x.key === 'volume');
  assert.ok(vol, '应该发现说话变少');
  assert.equal(vol.level, 'warn');
});

test('句子明显变短会被发现', () => {
  const long = '今天打了一下午的游戏感觉还行吧';
  const short = '嗯';
  const records = [
    ...dayMsgs('1', 1, 15, 15, short),
    ...dayMsgs('1', 2, 15, 15, short),
    ...dayMsgs('1', 3, 15, 15, short),
    ...dayMsgs('1', 5, 15, 20, long),
    ...dayMsgs('1', 6, 15, 20, long),
  ];
  const s = observeState(records, '1', { now: NOW });
  const len = s.signals.find((x) => x.key === 'len');
  assert.ok(len, '应该发现句子变短');
});

test('23 点说话不算「凌晨还醒着」', () => {
  const records = [
    ...dayMsgs('1', 1, 23, 20),
    ...dayMsgs('1', 2, 23, 20),
    ...dayMsgs('1', 3, 23, 20),
    ...dayMsgs('1', 5, 15, 20),
    ...dayMsgs('1', 6, 15, 20),
  ];
  const s = observeState(records, '1', { now: NOW });
  const late = s.signals.find((x) => x.key === 'latest');
  assert.equal(late, undefined, '23 点是正常时间，不该报警');
});

test('凌晨 3 点还在会报警', () => {
  const records = [
    ...dayMsgs('1', 1, 3, 20),
    ...dayMsgs('1', 2, 3, 20),
    ...dayMsgs('1', 3, 3, 20),
    ...dayMsgs('1', 5, 15, 20),
    ...dayMsgs('1', 6, 15, 20),
  ];
  const s = observeState(records, '1', { now: NOW });
  const late = s.signals.find((x) => x.key === 'latest');
  assert.ok(late, '凌晨 3 点应该报警');
  assert.match(late.label, /凌晨/);
});

test('跟平时差不多时不给信号', () => {
  // 最近 3 天和基线完全一样
  const same = [
    ...dayMsgs('1', 1, 15, 20),
    ...dayMsgs('1', 2, 15, 20),
    ...dayMsgs('1', 3, 15, 20),
    ...dayMsgs('1', 5, 15, 20),
    ...dayMsgs('1', 6, 15, 20),
    ...dayMsgs('1', 7, 15, 20),
  ];
  const s = observeState(same, '1', { now: NOW });
  assert.equal(s.signals.length, 0);
  assert.match(s.note, /差不多/);
});

test('findNotable 只挑有 warn 信号的', () => {
  const records = [
    // 1 号：异常
    ...dayMsgs('1', 1, 15, 2),
    ...dayMsgs('1', 2, 15, 2),
    ...dayMsgs('1', 5, 15, 30),
    ...dayMsgs('1', 6, 15, 30),
    // 2 号：正常
    ...dayMsgs('2', 1, 15, 20),
    ...dayMsgs('2', 2, 15, 20),
    ...dayMsgs('2', 5, 15, 20),
    ...dayMsgs('2', 6, 15, 20),
  ];
  const rows = findNotable(records, { now: NOW });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes('1'), '异常的人要在列表里');
  assert.ok(!ids.includes('2'), '正常的人不该出现');
});

test('不诊断：输出里不能有精神科词汇', () => {
  const records = [
    ...dayMsgs('1', 1, 3, 40, '嗯'),
    ...dayMsgs('1', 5, 15, 40),
  ];
  const s = observeState(records, '1', { now: NOW });
  const text = JSON.stringify(s);
  for (const bad of ['抑郁', '焦虑症', '精神病', '患者', '确诊']) {
    assert.ok(!text.includes(bad), `不该出现「${bad}」这种诊断词`);
  }
});

test('STATE_LIMITS 有值', () => {
  assert.ok(STATE_LIMITS.MIN_MESSAGES > 0);
  assert.ok(STATE_LIMITS.BASELINE_DAYS > 0);
});

// ── v2 新维度 ────────────────────────────────
import { __internal } from '../src/state-observe.js';

function dayMsgsAt(id, dayOffset, hour, count, text) {
  const d = new Date(NOW - dayOffset * DAY);
  d.setHours(hour, 0, 0, 0);
  return Array.from({ length: count }, (_, i) => msg(id, d.getTime() + i * 60000, text));
}

test('情绪词：负面词明显变多会被发现', () => {
  const records = [
    ...dayMsgsAt('1', 1, 15, 20, '好烦啊今天真累'),
    ...dayMsgsAt('1', 2, 15, 20, '难受睡不着'),
    ...dayMsgsAt('1', 5, 15, 20, '今天打游戏挺开心'),
    ...dayMsgsAt('1', 6, 15, 20, '哈哈好玩'),
    ...dayMsgsAt('1', 7, 15, 20, '还行吧'),
  ];
  const s = observeState(records, '1', { now: NOW });
  const neg = s.signals.find((x) => x.key === 'neg');
  assert.ok(neg, '负面词变多应该被发现');
  assert.equal(neg.group, '情绪');
});

test('情绪词：样本太小不误报（1 次变 0 次不算信号）', () => {
  // 最近只有 3 条，基线里正面词也不多
  const records = [
    ...dayMsgsAt('1', 1, 15, 3, '嗯'),
    ...dayMsgsAt('1', 5, 15, 40, '嗯嗯好'),
  ];
  const s = observeState(records, '1', { now: NOW });
  const pos = s.signals.find((x) => x.key === 'pos');
  assert.equal(pos, undefined, '1.1 次变 0 次不是信号');
});

test('社交：只跟一个人说话了会被发现', () => {
  const many = ['@甲 好', '@乙 在吗', '@丙 来', '@丁 走', '@戊 嗯'];
  const one = ['@甲 好', '@甲 嗯', '还行', '@甲 对', '嗯'];
  const records = [
    // 基线（5-14 天前）：天天 @ 好几个人 → 社交面广
    ...Array.from({ length: 10 }, (_, i) => {
      const d = new Date(NOW - (i + 5) * DAY);
      d.setHours(15, 0, 0, 0);
      return many.map((t, k) => msg('1', d.getTime() + k * 60000, t));
    }).flat(),
    // 最近 3 天：只 @ 甲一个人
    ...Array.from({ length: 12 }, (_, i) => msg('1', NOW - 60000 * (i + 1), one[i % one.length])),
    ...Array.from({ length: 12 }, (_, i) => msg('1', NOW - 3600000 * (i + 1), one[i % one.length])),
    ...Array.from({ length: 12 }, (_, i) => msg('1', NOW - 4000000 * (i + 1), one[i % one.length])),
  ];
  const s = observeState(records, '1', { now: NOW });
  const social = s.signals.find((x) => x.key === 'social');
  assert.ok(social, '社交收缩应该被发现');
  assert.equal(social.group, '社交');
});

test('连贯性：连发很多条会被发现', () => {
  const records = [
    // 基线：每天 6 条、间隔 1 分钟 → 最长连发 6
    ...Array.from({ length: 8 }, (_, d) => {
      const day = new Date(NOW - (d + 5) * DAY);
      day.setHours(15, 0, 0, 0);
      return [0, 1, 2, 3, 4, 5].map((k) => msg('1', day.getTime() + k * 60000, '正常说话'));
    }).flat(),
    // 最近：一口气 12 条
    ...Array.from({ length: 12 }, (_, i) => msg('1', NOW - 3600000 + i * 10000, '说一句')),
    ...Array.from({ length: 8 }, (_, i) => msg('1', NOW - 7200000 + i * 10000, '再说一句')),
    ...Array.from({ length: 8 }, (_, i) => msg('1', NOW - 86400000 + i * 10000, '还说一句')),
  ];
  const s = observeState(records, '1', { now: NOW });
  const streak = s.signals.find((x) => x.key === 'streak');
  assert.ok(streak, '连发应该被发现');
  assert.equal(streak.group, '连贯性');
});

test('mentioned 能抠出被 @ 的人', () => {
  const { mentioned } = __internal;
  assert.deepEqual(mentioned('@老王 在吗'), ['老王']);
  assert.deepEqual(mentioned('[回复]@老李 好'), ['老李']);
  assert.equal(mentioned('没有 at 的句子').length, 0);
});

test('isReplying 认出 @ 和 [回复]', () => {
  const { isReplying } = __internal;
  assert.equal(isReplying('@老王 在吗'), true);
  assert.equal(isReplying('[回复]你上次说的'), true);
  assert.equal(isReplying('普通一句话'), false);
});

test('countWords 不重复计数错位', () => {
  const { countWords } = __internal;
  assert.equal(countWords('累 累 累', ['累']), 3);
  assert.equal(countWords('没有情绪词', ['累']), 0);
});

test('情绪维度也有诊断词过滤', () => {
  const records = [
    ...dayMsgsAt('1', 1, 15, 20, '难受 累 烦'),
    ...dayMsgsAt('1', 5, 15, 20, '嗯嗯'),
  ];
  const s = observeState(records, '1', { now: NOW });
  const text = JSON.stringify(s);
  for (const bad of ['抑郁', '焦虑', '确诊', '心理疾病']) {
    assert.ok(!text.includes(bad), '不该出现「' + bad + '」');
  }
});

test('findNotable：limit 为 0 时不限制，有多少列多少', () => {
  // 造 6 个都有异常的人
  const records = [];
  for (let i = 1; i <= 6; i += 1) {
    const id = String(i);
    records.push(
      ...dayMsgsAt(id, 1, 15, 2),
      ...dayMsgsAt(id, 2, 15, 2),
      ...dayMsgsAt(id, 5, 15, 30),
      ...dayMsgsAt(id, 6, 15, 30),
    );
  }
  const all = findNotable(records, { now: NOW, limit: 0 });
  assert.equal(all.length, 6, 'limit=0 应该全部列出');
});

test('findNotable：不传 limit 也不截断', () => {
  const records = [];
  for (let i = 1; i <= 5; i += 1) {
    const id = String(i);
    records.push(
      ...dayMsgsAt(id, 1, 15, 2),
      ...dayMsgsAt(id, 2, 15, 2),
      ...dayMsgsAt(id, 5, 15, 30),
      ...dayMsgsAt(id, 6, 15, 30),
    );
  }
  const all = findNotable(records, { now: NOW });
  assert.ok(all.length >= 5, '默认不该截断，实际 ' + all.length);
});

test('findNotable：给了正数 limit 仍然生效', () => {
  const records = [];
  for (let i = 1; i <= 6; i += 1) {
    const id = String(i);
    records.push(
      ...dayMsgsAt(id, 1, 15, 2),
      ...dayMsgsAt(id, 2, 15, 2),
      ...dayMsgsAt(id, 5, 15, 30),
      ...dayMsgsAt(id, 6, 15, 30),
    );
  }
  const some = findNotable(records, { now: NOW, limit: 3 });
  assert.equal(some.length, 3, '明确的 limit 还是要守');
});

// ── 严重度排序 ────────────────────────────────
import { severityOf } from '../src/state-observe.js';

test('severityOf：负面词权重大于句子变短', () => {
  const neg = severityOf([{ key: 'neg', group: '情绪', level: 'warn' }]);
  const len = severityOf([{ key: 'len', group: '语言', level: 'warn' }]);
  assert.ok(neg > len, '情绪急转应该比句子变短更严重');
});

test('severityOf：同维度只算一次最高的', () => {
  // 情绪三个词都涨了，本质是同一件事，不该叠三倍
  const one = severityOf([{ key: 'neg', group: '情绪', level: 'warn' }]);
  const three = severityOf([
    { key: 'neg', group: '情绪', level: 'warn' },
    { key: 'apa', group: '情绪', level: 'warn' },
    { key: 'pos', group: '情绪', level: 'warn' },
  ]);
  assert.equal(three, one, '同维度取最高分，不能叠加');
});

test('severityOf：跨维度会累加', () => {
  const one = severityOf([{ key: 'neg', group: '情绪', level: 'warn' }]);
  const two = severityOf([
    { key: 'neg', group: '情绪', level: 'warn' },
    { key: 'gap', group: '作息', level: 'warn' },
  ]);
  assert.ok(two > one, '两个维度都出事的人分数更高');
});

test('severityOf：info 级不参与', () => {
  const s = severityOf([{ key: 'punct', group: '语言', level: 'info' }]);
  assert.equal(s, 0);
});

test('findNotable：按严重度从高到低排', () => {
  // A：情绪异常（neg，权重 100）
  // B：只是句子变短（len，权重 55）
  const records = [];
  // A 的基线：正常说话，最近突然全是负面词
  for (let d = 1; d <= 8; d += 1) {
    const day = new Date(NOW - (d + 5) * DAY);
    day.setHours(15, 0, 0, 0);
    // 每天 8 条，保证 7 天窗口内够 30 条基线
    for (let k = 0; k < 8; k += 1) records.push(msg('A', day.getTime() + k * 60000, '今天挺好'));
  }
  for (let i = 0; i < 40; i += 1) {
    records.push(msg('A', NOW - 60000 * (i + 1), '受不了 难受 烦'));
  }
  // B 的基线：长句子，最近变短
  for (let d = 1; d <= 8; d += 1) {
    const day = new Date(NOW - (d + 5) * DAY);
    day.setHours(15, 0, 0, 0);
    for (let k = 0; k < 8; k += 1) records.push(msg('B', day.getTime() + k * 60000, '今天打了一下午游戏感觉还行吧'));
  }
  for (let i = 0; i < 40; i += 1) {
    records.push(msg('B', NOW - 60000 * (i + 1), '嗯'));
  }

  const rows = findNotable(records, { now: NOW, limit: 0 });
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].id, 'A', '情绪异常的人应该排前面');
  assert.ok(rows[0].severity > rows[1].severity, rows[0].severity + ' 应该大于 ' + rows[1].severity);
});

// ── 猜测标签 ──────────────────────────────────
import { inferTags } from '../src/state-observe.js';

const sig = (key, group, level = 'warn') => ({ key, group, level });

test('标签：只说话变少 → 可能只是忙', () => {
  const tags = inferTags([sig('volume', '活跃度')]);
  assert.ok(tags.some((t) => t.key === 'quiet'), '只说话变少 → quiet 标签');
  assert.equal(tags[0].tone, 'calm', '语气要轻');
});

test('标签：负面词 + 社交收缩 → 像是心里有事', () => {
  const tags = inferTags([sig('neg', '情绪'), sig('social', '社交')]);
  assert.ok(tags.some((t) => t.key === 'multi'));
  assert.ok(tags.some((t) => t.tone === 'hot'), '语气要重');
});

test('标签：只负面词涨、社交没变 → 说轻一点', () => {
  const tags = inferTags([sig('neg', '情绪')]);
  assert.ok(tags.some((t) => t.key === 'heavy-words'));
  assert.ok(!tags.some((t) => t.key === 'multi'), '社交没变就不该出 multi');
  assert.equal(tags.find((t) => t.key === 'heavy-words').tone, 'warm');
});

test('标签：同名标签不重复', () => {
  const tags = inferTags([sig('volume', '活跃度')]);
  const texts = tags.map((t) => t.text);
  assert.equal(new Set(texts).size, texts.length, '不能有重复标签');
});

test('标签：最多三个', () => {
  const tags = inferTags([
    sig('volume', '活跃度'), sig('neg', '情绪'), sig('apa', '情绪'),
    sig('gap', '作息'), sig('social', '社交'), sig('reply', '社交'),
    sig('night', '作息'), sig('latest', '作息'),
  ]);
  assert.ok(tags.length <= 3);
});

test('标签：不出现病名', () => {
  const all = [
    sig('volume', '活跃度'), sig('neg', '情绪'), sig('apa', '情绪'),
    sig('gap', '作息'), sig('social', '社交'), sig('reply', '社交'),
    sig('pos', '情绪'), sig('len', '语言'), sig('night', '作息'),
  ];
  const text = JSON.stringify(inferTags(all));
  for (const bad of ['抑郁', '焦虑症', '确诊', '心理疾病', '精神病']) {
    assert.ok(!text.includes(bad), '不该出现「' + bad + '」');
  }
});

test('标签：没有 warn 时返回空', () => {
  assert.deepEqual(inferTags([sig('punct', '语言', 'info')]), []);
  assert.deepEqual(inferTags([]), []);
});

// ── 按群分组 ──────────────────────────────────
import { findNotableByGroup } from '../src/state-observe.js';

function withKey(list, key) {
  return list.map((r) => ({ ...r, key }));
}

test('findNotableByGroup：不同群分开算，不混在一起', () => {
  // 甲在 A 群非常活跃、在 B 群几乎不说话。
  // 混在一起算的话，两边的"变化"会互相抵消。
  const a = [];
  const b = [];
  for (let d = 1; d <= 8; d += 1) {
    const day = new Date(NOW - (d + 5) * DAY);
    day.setHours(15, 0, 0, 0);
    for (let k = 0; k < 8; k += 1) a.push(msg('X', day.getTime() + k * 60000, '正常说话'));
  }
  for (let i = 0; i < 40; i += 1) a.push(msg('X', NOW - 60000 * (i + 1), '受不了 难受 烦'));
  // B 群：完全正常
  for (let d = 1; d <= 8; d += 1) {
    const day = new Date(NOW - (d + 5) * DAY);
    day.setHours(15, 0, 0, 0);
    for (let k = 0; k < 8; k += 1) b.push(msg('X', day.getTime() + k * 60000, '还好'));
  }
  for (let i = 0; i < 40; i += 1) b.push(msg('X', NOW - 60000 * (i + 1), '还好'));

  const { groups } = findNotableByGroup([...withKey(a, 'group:A'), ...withKey(b, 'group:B')], { now: NOW, limit: 0 });
  assert.equal(groups.length, 2, '两个群各一组');

  const ga = groups.find((g) => g.key === 'group:A');
  const gb = groups.find((g) => g.key === 'group:B');
  assert.ok(ga.people.length > 0, 'A 群里这个人有异常');
  assert.equal(gb.people.length, 0, 'B 群里同一个人很正常');
});

test('findNotableByGroup：没 key 的记录归到 unknown', () => {
  const recs = [];
  for (let i = 0; i < 40; i += 1) recs.push(msg('Y', NOW - 60000 * (i + 1), '嗯'));
  const { groups } = findNotableByGroup(recs, { now: NOW });
  assert.ok(groups.some((g) => g.key === 'unknown'));
});

test('findNotableByGroup：人多的群排前面', () => {
  const ok = [];
  for (let d = 1; d <= 8; d += 1) {
    const day = new Date(NOW - (d + 5) * DAY);
    day.setHours(15, 0, 0, 0);
    for (let k = 0; k < 8; k += 1) ok.push(msg('Z', day.getTime() + k * 60000, '正常'));
  }
  // A 群：两个异常的人
  const a = [
    ...withKey([...ok, ...Array.from({ length: 20 }, (_, i) => msg('P1', NOW - 60000 * (i + 1), '嗯'))], 'group:A'),
    ...withKey([...ok, ...Array.from({ length: 20 }, (_, i) => msg('P2', NOW - 60000 * (i + 1), '嗯'))], 'group:A'),
  ];
  const b = withKey([...ok, ...Array.from({ length: 20 }, (_, i) => msg('P3', NOW - 60000 * (i + 1), '嗯'))], 'group:B');

  const { groups } = findNotableByGroup([...a, ...b], { now: NOW, limit: 0 });
  assert.equal(groups[0].key, 'group:A', '人多（异常多）的群排前面');
});

test('findNotableByGroup：groupKey 可以只看一个群', () => {
  const recs = [
    ...withKey(Array.from({ length: 40 }, (_, i) => msg('Q', NOW - 60000 * (i + 1), '嗯')), 'group:A'),
    ...withKey(Array.from({ length: 40 }, (_, i) => msg('R', NOW - 60000 * (i + 1), '嗯')), 'group:B'),
  ];
  const { groups } = findNotableByGroup(recs, { now: NOW, groupKey: 'group:A' });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'group:A');
});

test('标签：负面词 + 少说话 + 句子短 → 像是有压力', () => {
  const tags = inferTags([
    sig('volume', '活跃度'), sig('len', '语言'), sig('neg', '情绪'), sig('social', '社交'),
  ]);
  assert.ok(tags.some((t) => t.key === 'many-shifts'), '多项同时变化');
});

test('标签：少说话 + 句子短 + 无负面词 → 像是累着了', () => {
  const tags = inferTags([sig('volume', '活跃度'), sig('len', '语言')]);
  assert.ok(tags.some((t) => t.key === 'short-quiet'));
  assert.ok(!tags.some((t) => t.key === 'many-shifts'), '没有负面词就不该出 many-shifts');
});

test('标签：标签按语气排序，红的在前', () => {
  const tags = inferTags([
    sig('volume', '活跃度'), sig('len', '语言'), sig('neg', '情绪'), sig('social', '社交'),
  ]);
  assert.ok(tags.length >= 2);
  assert.equal(tags[0].tone, 'hot', '红色的必须排第一');
});

test('标签：截到三个时优先保留严重的', () => {
  // 这条组合会同时命中 hot 和 calm 好几种
  const tags = inferTags([
    sig('volume', '活跃度'), sig('len', '语言'), sig('neg', '情绪'),
    sig('apa', '情绪'), sig('social', '社交'), sig('reply', '社交'),
  ]);
  assert.ok(tags.length <= 3, '最多三个');
  assert.ok(tags.some((t) => t.tone === 'hot'), '严重的那条不能被挤掉');
});

// ── 阈值：别把正常波动当异常 ──
test('负面词：绝对密度不够高就不算（0.8 → 1.7 是正常起伏）', () => {
  // mwei 那种：比例翻倍，但一天讲不到两次"累"
  const records = [
    ...Array.from({ length: 8 }, (_, d) => {
      const day = new Date(NOW - (d + 5) * DAY);
      day.setHours(15, 0, 0, 0);
      return Array.from({ length: 10 }, (_, k) => msg('1', day.getTime() + k * 60000, '今天还行吧'));
    }).flat(),
    ...Array.from({ length: 40 }, (_, i) => msg('1', NOW - 60000 * (i + 1), i % 60 === 0 ? '有点累' : '正常说话')),
  ];
  const s = observeState(records, '1', { now: NOW });
  const neg = s.signals.find((x) => x.key === 'neg');
  assert.equal(neg, undefined, '密度不够，不该报负面词变多');
});

test('说话变少：还是很活跃就不算（200 → 54 条/天）', () => {
  // 比例掉了很多，但 54 条/天仍然是话很多的人
  const base = Array.from({ length: 8 }, (_, d) => {
    const day = new Date(NOW - (d + 5) * DAY);
    day.setHours(15, 0, 0, 0);
    // 每天 200 条
    return Array.from({ length: 200 }, (_, k) => msg('1', day.getTime() + k * 1000, '说话'));
  }).flat();
  // 最近 3 天每天约 54 条
  const recent = Array.from({ length: 3 }, (_, d) => {
    const day = new Date(NOW - (d + 1) * DAY);
    day.setHours(15, 0, 0, 0);
    return Array.from({ length: 54 }, (_, k) => msg('1', day.getTime() + k * 3000, '说话'));
  }).flat();
  const s = observeState([...base, ...recent], '1', { now: NOW });
  const vol = s.signals.find((x) => x.key === 'volume');
  assert.equal(vol, undefined, '54 条/天还算活跃，不该报"说话变少"');
});

test('说话变少：真掉到很低才报', () => {
  const base = Array.from({ length: 8 }, (_, d) => {
    const day = new Date(NOW - (d + 5) * DAY);
    day.setHours(15, 0, 0, 0);
    return Array.from({ length: 60 }, (_, k) => msg('1', day.getTime() + k * 1000, '说话'));
  }).flat();
  const recent = Array.from({ length: 3 }, (_, d) => {
    const day = new Date(NOW - (d + 1) * DAY);
    day.setHours(15, 0, 0, 0);
    return Array.from({ length: 5 }, (_, k) => msg('1', day.getTime() + k * 3000, '说话'));
  }).flat();
  const s = observeState([...base, ...recent], '1', { now: NOW });
  assert.ok(s.signals.find((x) => x.key === 'volume'), '5 条/天就该报了');
});

test('正面词变多是反证：不该再贴负面标签', () => {
  // 负面词涨了，但正面词涨得更多
  const tags = inferTags([
    { key: 'neg', group: '情绪', level: 'warn' },
    { key: 'social', group: '社交', level: 'warn' },
    { key: 'pos-up', group: '情绪', level: 'info' },
  ]);
  assert.ok(!tags.some((t) => t.key === 'multi'), '心情在往上走，不该出 multi');
});

// ── 边界：这些数据只给面板，不拿去跟当事人互动 ──
//
// 2026-11-05 定的规矩。从聊天记录算出来"状态不好"再去关心，
// 不是关心，是居高临下 —— 当事人没同意被这样分析。
// 真关心应该在当场那句接话里，不从数据推。

test('边界：模块不导出任何"发消息/关心"的出口', async () => {
  const mod = await import('../src/state-observe.js');
  const names = Object.keys(mod);
  // 只该有分析相关的导出，不该有 send/notify/care 这类
  const forbidden = /send|notify|care|console|message|dm|private/i;
  const bad = names.filter((n) => forbidden.test(n));
  assert.deepEqual(bad, [], '要是想加"发给当事人"的功能，加在接话逻辑里，别加在这');
});

test('边界：标签里不出现揣测性的词', () => {
  // 面板上会显示的所有标签文案，只描述"哪儿变了"，不猜"怎么回事"
  const all = JSON.stringify([
    { key: 'quiet', text: '只在说话量上有变化' },
    { key: 'multi', text: '多处跟平时不一样' },
    { key: 'heavy-words', text: '用词比以前重' },
    { key: 'withdrawn', text: '参与度明显降低' },
    { key: 'less-reply', text: '主动接话少了' },
    { key: 'late-hours', text: '活动时间后移' },
    { key: 'many-shifts', text: '多项指标同时变化' },
    { key: 'short-quiet', text: '话少且句子短' },
  ]);
  for (const bad of ['压力', '心烦', '心里有事', '提不起劲', '抑郁', '焦虑', '累着了']) {
    assert.ok(!all.includes(bad), '不该出现「' + bad + '」');
  }
});
