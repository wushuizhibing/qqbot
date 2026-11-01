import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMoodState, pushMoodPoint, makePoint } from '../src/core.js';
import { carryMood, amplifyIntensity, agedIntensity, intensityLabel, MAX_CARRY_ROUNDS } from '../src/emotion.js';
import { normalizeMood, normalizeIntensity } from '../src/normalize.js';
import { classifyMood, moodDistribution, recentPoints, MOOD_CLASSES } from '../src/mood-stats.js';
import { createMoodLog } from '../src/mood-log.js';
import { collectPeople, relationSummary } from '../src/people.js';
import { relationshipOf, relationshipHint } from '../src/relationship.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moodkit-'));
const tmpFile = () => path.join(tmp, `m-${Math.random().toString(16).slice(2)}.json`);

// ── 规整 ──────────────────────────────────────────
test('normalizeIntensity：钳到 0-10，脏数据归零', () => {
  assert.equal(normalizeIntensity(0), 0);
  assert.equal(normalizeIntensity(6), 6);
  assert.equal(normalizeIntensity(99), 10);
  assert.equal(normalizeIntensity(-5), 0);
  assert.equal(normalizeIntensity('7'), 7);
  assert.equal(normalizeIntensity('abc'), 0);
});

test('normalizeMood：去引号、限长、"无"当空', () => {
  assert.equal(normalizeMood('「有点烦」'), '有点烦');
  assert.equal(normalizeMood('无'), '');
  assert.equal(normalizeMood(''), '');
  assert.ok(normalizeMood('x'.repeat(200)).length <= 60);
});

// ── 强度 ──────────────────────────────────────────
test('amplifyIntensity：有情绪就放大并托底，没情绪仍是 0', () => {
  assert.equal(amplifyIntensity(0), 0);
  assert.equal(amplifyIntensity(1), 2, '至少到 2');
  assert.ok(amplifyIntensity(4) >= 5);
  assert.equal(amplifyIntensity(9), 10, '上限 10');
});

test('intensityLabel：分档', () => {
  assert.equal(intensityLabel(0), '');
  assert.match(intensityLabel(2), /很淡/);
  assert.match(intensityLabel(6), /明显/);
  assert.match(intensityLabel(10), /上头/);
});

test('agedIntensity：6 小时减半，一天后基本散掉', () => {
  const now = 1_000_000_000_000;
  const h6 = 6 * 60 * 60 * 1000;
  const h24 = 24 * 60 * 60 * 1000;
  assert.equal(agedIntensity({ intensity: 8, since: now }, now), 8);
  assert.equal(agedIntensity({ intensity: 8, since: now }, now + h6), 4);
  assert.ok(agedIntensity({ intensity: 8, since: now }, now + h24) <= 2);
});

// ── 沿用上限 ──────────────────────────────────────
test('carryMood：最多沿用 MAX_CARRY_ROUNDS 轮就清空', () => {
  let prev = { mood: '被怼了，不爽', intensity: 8, carried: 0 };
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    prev = carryMood({ text: 'x', mood: '' }, prev);
    seen.push(prev.mood);
  }
  assert.ok(seen[0].length > 0 && seen[1].length > 0, '前两轮沿用');
  assert.equal(seen[2], '', '第三轮清空');
  assert.equal(MAX_CARRY_ROUNDS, 2);
});

test('carryMood：新情绪来了重置沿用计数', () => {
  const out = carryMood({ mood: '来精神了', intensity: 6 }, { mood: '旧的', intensity: 4, carried: 2 });
  assert.equal(out.mood, '来精神了');
  assert.equal(out.carried, 0);
});

// ── 分类 ──────────────────────────────────────────
test('classifyMood：关键词归类', () => {
  assert.equal(classifyMood('被人开玩笑，有点不爽').cls, '烦');
  assert.equal(classifyMood('有人喊开黑，来精神了').cls, '开心');
  assert.equal(classifyMood('有点好奇').cls, '好奇');
  assert.equal(classifyMood('困得只想躺平').cls, '疲惫');
  assert.equal(classifyMood('').cls, '平静');
});

test('classifyMood：反义词和易混淆组合不能误判', () => {
  assert.notEqual(classifyMood('被人抢先接梗，我反而松了口气').cls, '烦');
  assert.equal(classifyMood('还是没劲').cls, '疲惫');
  assert.equal(classifyMood('懒得动了').cls, '疲惫');
  assert.equal(classifyMood('提不起劲').cls, '疲惫');
});

test('moodDistribution：强度加权，占比合计为 1', () => {
  const d = moodDistribution([
    { mood: '被怼了很不爽', intensity: 8 },
    { mood: '', intensity: 0 },
    { mood: '有点好奇', intensity: 3 },
  ]);
  const sum = Object.values(d.ratio).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.001);
  for (const c of MOOD_CLASSES) assert.ok(c in d.ratio);
});

test('recentPoints：按时间窗过滤', () => {
  const now = Date.now();
  const pts = [
    { at: now - 30 * 60 * 1000 },
    { at: now - 5 * 60 * 60 * 1000 },
    { at: now - 48 * 60 * 60 * 1000 },
  ];
  assert.equal(recentPoints(pts, 1, now).length, 1);
  assert.equal(recentPoints(pts, 24, now).length, 2);
  assert.equal(recentPoints(pts, 72, now).length, 3);
});

// ── 历史点 ────────────────────────────────────────
test('pushMoodPoint：同一句情绪 5 分钟内合并，不重复写', () => {
  const hist = [];
  const t = 1793248000000;
  pushMoodPoint(hist, { at: t, sessionKey: 'g:1', mood: '有点烦' });
  pushMoodPoint(hist, { at: t + 1000, sessionKey: 'g:1', mood: '有点烦' });
  assert.equal(hist.length, 1, '合并成一个点');
  pushMoodPoint(hist, { at: t + 10 * 60 * 1000, sessionKey: 'g:1', mood: '有点烦' });
  assert.equal(hist.length, 2, '过了窗口就新增');
});

// ── 落盘 ──────────────────────────────────────────
test('mood-log：写入后跨实例读回（模拟重启）', () => {
  const file = tmpFile();
  const a = createMoodLog({ file });
  a.push(makePoint({ at: 1, sessionKey: 'g:1', mood: '有点烦', intensity: 3 }));
  const b = createMoodLog({ file });
  assert.equal(b.all().length, 1);
});

test('effectiveIntensity：情绪隔一天要真的散掉（不能被下限托住）', async () => {
  const { effectiveIntensity } = await import('../src/emotion.js');
  const now = 1_000_000_000_000;
  const h = 60 * 60 * 1000;
  // 刚产生：放大
  assert.ok(effectiveIntensity({ intensity: 8, since: now }, now) >= 9, '新情绪要放大');
  // 6 小时：减半左右
  const h6 = effectiveIntensity({ intensity: 8, since: now }, now + 6 * h);
  assert.ok(h6 > 0 && h6 <= 6, `6h 后该变淡，实际 ${h6}`);
  // 一天后：彻底归零（这是之前的 bug：会永远停在 2）
  assert.equal(effectiveIntensity({ intensity: 8, since: now }, now + 24 * h), 0, '一天后要归零');
  assert.equal(effectiveIntensity({ intensity: 8, since: now }, now + 240 * h), 0, '十天后必须还是 0');
  // 弱情绪散得更快
  assert.equal(effectiveIntensity({ intensity: 2, since: now }, now + 12 * h), 0, '弱情绪半天就该没了');
});

test('effectiveIntensity：没 since 的当新鲜处理', async () => {
  const { effectiveIntensity } = await import('../src/emotion.js');
  assert.ok(effectiveIntensity({ intensity: 6 }, Date.now()) > 0);
  assert.equal(effectiveIntensity({ intensity: 0 }, Date.now()), 0);
  assert.equal(effectiveIntensity(null, Date.now()), 0);
});

test('createMoodState：重启后能恢复各会话的情绪', async () => {
  const { createMoodState } = await import('../src/core.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moodkit-restore-'));
  const file = path.join(dir, 'r.json');

  const st1 = createMoodState({ file });
  st1.observe({ sessionKey: 'group:A', mood: '被怼了，有点烦', intensity: 6 });
  st1.observe({ sessionKey: 'group:B', mood: '有人夸我，开心', intensity: 5 });
  st1.save();

  // 新实例 = 重启
  const st2 = createMoodState({ file });
  const a = st2.current('group:A');
  assert.ok(a.mood, '重启后别把情绪弄丢');
  assert.match(a.mood, /烦/);
  assert.ok(a.intensity > 0, '强度也要跟着回来');
  assert.ok(st2.current('group:B').mood, '另一个会话也要恢复');
  assert.equal(st2.current('group:C').mood, '', '没见过的会话是空的');
});

test('classifyMood：事件描述不能被当成情绪', () => {
  // 「被点名」只说明发生了什么，不说明感受 —— 曾经让尴尬占到 100%
  assert.equal(classifyMood('被点名了，有点好奇他要干嘛。').cls, '好奇');
  assert.equal(classifyMood('被点名调侃，有点想回嘴').cls, '烦');
  // 真尴尬的说法还是要认
  assert.equal(classifyMood('被拆穿了，社死').cls, '尴尬');
  assert.equal(classifyMood('有点不好意思').cls, '尴尬');
  // 否定词不能反转
  assert.equal(classifyMood('松了口气').cls, '平静');
});

// ── 淡化与过期 ──────────────────────────────────
test('displayWeight：分四段淡出，越旧越淡', async () => {
  const { displayWeight } = await import('../src/fade.js');
  const now = Date.now();
  const h = 3600000;
  const d = 24 * h;
  assert.equal(displayWeight(now, now), 1, '刚发生：满亮');
  assert.equal(displayWeight(now - 6 * h, now), 1, '半天内：还是满亮');
  assert.equal(displayWeight(now - 20 * h, now), 0.85, '接近一天：稍微退后');
  assert.equal(displayWeight(now - 2 * d, now), 0.6, '两三天：开始淡');
  assert.equal(displayWeight(now - 5 * d, now), 0.3, '五天内：只剩痕迹');
  assert.equal(displayWeight(now - 10 * d, now), 0.12, '更早：几乎透明');
  // 单调不增
  const seq = [0, 6, 20, 48, 120, 300].map((hh) => displayWeight(now - hh * h, now));
  for (let i = 1; i < seq.length; i += 1) assert.ok(seq[i] <= seq[i - 1], `第 ${i} 个不该变亮`);
});

test('displayWeight：时间戳坏了当新的，别误判成旧', async () => {
  const { displayWeight } = await import('../src/fade.js');
  assert.equal(displayWeight('abc'), 1);
  assert.equal(displayWeight(undefined), 1);
});

test('isExpired：超过保留期才删', async () => {
  const { isExpired } = await import('../src/fade.js');
  const now = Date.now();
  const d = 86400000;
  assert.equal(isExpired(now - 6 * d, 7, now), false, '6 天还在');
  assert.equal(isExpired(now - 8 * d, 7, now), true, '8 天要删');
  assert.equal(isExpired('broken', 7, now), false, '坏的别删');
});

test('freshPoints：真实时间戳才按时间裁，小数字一律保留', async () => {
  const { freshPoints } = await import('../src/fade.js');
  const now = Date.now();
  const d = 86400000;
  const real = [
    { at: now - 1 * d, mood: '新' },
    { at: now - 10 * d, mood: '旧' },
  ];
  assert.equal(freshPoints(real, 7, now).length, 1, '过期的被裁掉');
  // 测试里的小数字（不像真实毫秒时间戳）全部保留
  const tiny = [{ at: 1 }, { at: 2 }, { at: 3 }];
  assert.equal(freshPoints(tiny, 7, now).length, 3, '小数字别误删');
});

test('createMoodState：points() 带 weight，过期点被过滤', async () => {
  const { createMoodState } = await import('../src/core.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moodkit-fade-'));
  const file = path.join(dir, 'f.json');
  const now = Date.now();
  const d = 86400000;
  // 直接写文件模拟历史：一条新的、一条 10 天前的
  fs.writeFileSync(
    file,
    JSON.stringify([
      { at: now - 10 * d, sessionKey: 'g:1', mood: '很久以前', polarity: -1, intensity: 2 },
      { at: now - 60000, sessionKey: 'g:1', mood: '刚刚', polarity: 0, intensity: 2 },
    ]),
    'utf8',
  );
  const st = createMoodState({ file, keepDays: 7 });
  const pts = st.points();
  assert.equal(pts.length, 1, '10 天前的点该被过滤');
  assert.ok(typeof pts[0].weight === 'number', '每个点要带 weight');
  assert.ok(pts[0].weight > 0.9, '新的点应该很亮');
});

test('classifyMood：词表要覆盖模型常用的说法（星图一片平静通常是词表太窄）', () => {
  // 这些是真实历史里"无命中掉进平静"的句子，现在都应该有归属
  const cases = [
    ['被点名喊出来，有点被cue到的兴奋', '开心'],
    ['被点名了，探头看看啥事', '好奇'],
    ['被人当成在账本边上啃零食的，有点想逗回去', '开心'],
    ['被点名点活儿，有点来劲', '开心'],
    ['被人夸了，心里有点美。', '得意'],
    ['被点名说没事干，有点不爽。', '烦'],
    ['又拿我编故事，气笑', '烦'],
    ['有点好奇他要干嘛', '好奇'],
    ['那句话飘过来，我有点摸不着头脑', '好奇'],
    ['有人去校医，我有点替他担心', '烦'],
  ];
  for (const [text, expect] of cases) {
    assert.equal(classifyMood(text).cls, expect, '"' + text + '" 应该归到 ' + expect);
  }
});

test('classifyMood：无聊是没兴致（疲惫），不是被惹到（烦）', () => {
  assert.equal(classifyMood('他喊无聊，我也只是看看，没劲').cls, '疲惫');
  assert.equal(classifyMood('还是没人搭理我，有点无聊').cls, '疲惫');
});

test('classifyMood：否定说法不能被当成好奇', () => {
  assert.equal(classifyMood('没什么事').cls, '平静');
  assert.equal(classifyMood('勾不起兴趣').cls, '疲惫');
});

test('classifyMood：单字不能误伤别的词', () => {
  // "美"曾经在开心词表里，于是"美工刀"被判成开心
  assert.equal(classifyMood('美工刀划到手了').cls, '平静');
});

// ── 代码过期检测 ──────────────────────────────────
test('staleness：没改文件时检测不到变更', async () => {
  const { snapshot, changedSince } = await import('../src/staleness.js');
  const snap = snapshot();
  assert.deepEqual(changedSince(snap), [], '刚拍完快照不该有变更');
});

test('staleness：改了被监控的文件能检测到', async () => {
  const { snapshot, changedSince, WATCHED, ROOT } = await import('../src/staleness.js');
  const fs = await import('node:fs');
  const path = await import('node:path');

  const snap = snapshot();
  const target = path.join(ROOT, 'src', 'fade.js');
  const original = fs.readFileSync(target, 'utf8');
  try {
    // mtime 精度可能只有秒级，等一会儿再改
    await new Promise((r) => setTimeout(r, 60));
    fs.writeFileSync(target, original + '\n// staleness test\n', 'utf8');
    const changed = changedSince(snap);
    assert.equal(changed.length, 1, '应该只检测到一个变更');
    assert.equal(changed[0].file, 'src/fade.js');
  } finally {
    fs.writeFileSync(target, original, 'utf8');
  }
});

test('staleness：WATCHED 里的文件都真实存在', async () => {
  const { WATCHED, ROOT } = await import('../src/staleness.js');
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const rel of WATCHED) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel + ' 不存在（清单该更新了）');
  }
});

test('collectPanelState：stale 会透传给面板', async () => {
  const { collectPanelState } = await import('../src/panel.js');
  const { createMoodState } = await import('../src/core.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-panel-'));
  const st = createMoodState({ file: path.join(dir, 'm.json') });
  const s = collectPanelState({
    state: st,
    stale: [{ file: 'src/panel.js', changedAt: Date.now() }],
  });
  assert.equal(s.stale.length, 1);
  assert.equal(s.stale[0].file, 'src/panel.js');
});

test('carryMood：隔太久就不再沿用（光有轮数不够）', async () => {
  const { carryMood, CARRY_WINDOW_MS } = await import('../src/emotion.js');
  const now = 1_700_000_000_000;
  const min = 60 * 1000;

  // carried 虽没到上限，但已经过去 20 分钟 —— 该散就散
  const stale = carryMood(
    { text: '', mood: '' },
    { mood: '被点名怼了，有点不服。', intensity: 3, carried: 1, since: now - 20 * min },
    now,
  );
  assert.equal(stale.mood, '', '超过时间窗要清空');
  assert.equal(stale.carried, 0);

  // 刚过去 2 分钟 —— 可以延续
  const fresh = carryMood(
    { text: '', mood: '' },
    { mood: '被点名怼了，有点不服。', intensity: 3, carried: 1, since: now - 2 * min },
    now,
  );
  assert.ok(fresh.mood, '窗口内继续沿用');

  assert.equal(CARRY_WINDOW_MS, 10 * 60 * 1000, '窗口是 10 分钟');
});

test('carryMood：这是"挂半小时不变"那个 bug 的回归测试', async () => {
  // 真实场景：23:32 产生情绪 → 23:35 沿用满 2 轮 → 群里安静 15 分钟 → 23:50 又来消息。
  // 修复前 carried 停在 2 然后被重置成 1，同一句情绪又续两轮，看起来像永远不变。
  const { carryMood } = await import('../src/emotion.js');
  const min = 60 * 1000;
  const t0 = 1_700_000_000_000;

  let s = carryMood({ text: '', mood: '被点名怼了，有点不服。', intensity: 6 }, null, t0);
  assert.equal(s.carried, 0, '新情绪');

  s = carryMood({ text: '', mood: '' }, s, t0 + 1 * min);
  assert.equal(s.carried, 1, '第 1 轮沿用');

  s = carryMood({ text: '', mood: '' }, s, t0 + 3 * min);
  assert.equal(s.carried, 2, '第 2 轮沿用');

  // 安静 15 分钟后回来
  const later = carryMood({ text: '', mood: '' }, s, t0 + 18 * min);
  assert.equal(later.mood, '', '隔了 15 分钟，旧情绪必须散掉');
});
