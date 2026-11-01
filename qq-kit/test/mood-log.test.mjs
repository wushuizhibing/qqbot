import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createMoodLog } from '../src/mood-log.js';

const require = createRequire(import.meta.url);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqkit-mood-'));
const mk = (n = 1) => path.join(tmp, `mood-${n}-${Math.random().toString(16).slice(2)}.json`);
const point = (at, mood = '有点烦', intensity = 6) => ({ at, sessionKey: 'group:1', mood, polarity: -0.5, intensity });

test('mood-log：写入后跨实例读回（模拟重启）', () => {
  const file = mk();
  const a = createMoodLog({ file });
  a.push(point(1000));
  a.push(point(2000, '来劲了', 7));

  const b = createMoodLog({ file });
  const all = b.all();
  assert.equal(all.length, 2);
  assert.equal(all[1].mood, '来劲了');
  assert.equal(all[1].intensity, 7);
});

test('mood-log：超过上限砍最早的', () => {
  const file = mk();
  const log = createMoodLog({ file, max: 3 });
  for (let i = 0; i < 5; i += 1) log.push(point(i));
  assert.equal(log.all().length, 3);
  assert.equal(log.all()[0].at, 2, '最早的点被砍掉');
});

test('mood-log：文件不存在时当空库，不报错', () => {
  const warnings = [];
  const log = createMoodLog({ file: mk(), warn: (m) => warnings.push(m) });
  assert.deepEqual(log.all(), []);
  assert.equal(warnings.length, 0);
});

test('mood-log：文件损坏时告警并当空库', () => {
  const file = mk();
  fs.writeFileSync(file, '{ 坏掉的 json', 'utf8');
  const warnings = [];
  const log = createMoodLog({ file, warn: (m) => warnings.push(m) });
  assert.deepEqual(log.all(), []);
  assert.equal(warnings.length, 1);
  // 还能继续写
  log.push(point(1));
  assert.equal(createMoodLog({ file }).all().length, 1);
});

test('mood-log：没配文件也能用，只是不落盘', () => {
  const log = createMoodLog({});
  log.push(point(1));
  assert.equal(log.size(), 1);
});

test('摘要存储：强度与 since 一起活下来', () => {
  const file = mk();
  const { createStore } = require('../src/storage.js');
  const a = createStore({ file });
  a.set('group:1', { text: 's', mood: '有点烦', intensity: 7, since: 12345 });
  a.save();
  const got = createStore({ file }).get('group:1');
  assert.equal(got.mood, '有点烦');
  assert.equal(got.intensity, 7);
  assert.equal(got.since, 12345, 'since 要活下来，否则老化会重新计时');
});

test('mood-log：超过 7 天的旧点自动丢掉（用真实时间戳）', () => {
  const file = mk();
  const now = Date.now();
  const old = now - 8 * 24 * 60 * 60 * 1000;  // 8 天前
  const recent = now - 60 * 1000;             // 1 分钟前
  fs.writeFileSync(
    file,
    JSON.stringify([{ at: old, sessionKey: 'group:1', mood: '旧的', polarity: 0, intensity: 3 },
                     { at: recent, sessionKey: 'group:1', mood: '新的', polarity: 0, intensity: 2 }]),
    'utf8',
  );
  const log = createMoodLog({ file, keepDays: 7 });
  const all = log.all();
  assert.equal(all.length, 1, '8 天前的点应该被丢掉');
  assert.equal(all[0].mood, '新的');
});

test('mood-log：时间戳不可信时不按时间删（避免误删）', () => {
  const file = mk();
  fs.writeFileSync(file, JSON.stringify([{ at: 1, mood: 'a', polarity: 0, intensity: 1 },
                                          { at: 2, mood: 'b', polarity: 0, intensity: 1 }]), 'utf8');
  const log = createMoodLog({ file, keepDays: 7 });
  assert.equal(log.all().length, 2, '小数字时间戳不该被当成过期');
});

// ── 情绪分类与星图统计 ──────────────────────────────
test('classifyMood：关键词归类', async () => {
  const { classifyMood } = await import('../src/mood-stats.js');
  assert.equal(classifyMood('被人开玩笑，有点不爽').cls, '烦');
  assert.equal(classifyMood('有人喊开黑，来精神了').cls, '开心');
  assert.equal(classifyMood('看到几张图，有点好奇').cls, '好奇');
  assert.equal(classifyMood('困得只想躺平').cls, '疲惫');
  assert.equal(classifyMood('被夸了一句，有点得意').cls, '得意');
  assert.equal(classifyMood('').cls, '平静');
  assert.equal(classifyMood('无').cls, '平静');
});

test('moodDistribution：强度加权，平静占分母', async () => {
  const { moodDistribution, MOOD_CLASSES } = await import('../src/mood-stats.js');
  const pts = [
    { mood: '被怼了很不爽', intensity: 8 },
    { mood: '', intensity: 0 },
    { mood: '', intensity: 0 },
    { mood: '有点好奇', intensity: 3 },
  ];
  const d = moodDistribution(pts);
  assert.ok(d.total > 0);
  // 所有类别都要有 key
  for (const c of MOOD_CLASSES) assert.ok(c in d.ratio, `${c} 缺失`);
  // 各占比加起来约等于 1
  const sum = Object.values(d.ratio).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.001, `占比合计应为 1，实际 ${sum}`);
  // 高强度负面应该压过弱好奇
  assert.ok(d.ratio['烦'] > d.ratio['好奇']);
});

test('recentPoints：按时间窗过滤', async () => {
  const { recentPoints } = await import('../src/mood-stats.js');
  const now = Date.now();
  const pts = [
    { at: now - 30 * 60 * 1000 },      // 30 分钟前
    { at: now - 5 * 60 * 60 * 1000 },  // 5 小时前
    { at: now - 48 * 60 * 60 * 1000 }, // 2 天前
  ];
  assert.equal(recentPoints(pts, 1, now).length, 1);
  assert.equal(recentPoints(pts, 24, now).length, 2);
  assert.equal(recentPoints(pts, 72, now).length, 3);
});

test('classifyMood：反义词和易混淆组合不能误判', async () => {
  const { classifyMood } = await import('../src/mood-stats.js');
  // "松了口气"里的"气"不是生气
  assert.notEqual(classifyMood('被人抢先接梗，我反而松了口气').cls, '烦', '松口气不该算烦');
  // "没劲/懒得/提不起" 属疲惫，不属烦
  assert.equal(classifyMood('还是没劲').cls, '疲惫');
  assert.equal(classifyMood('懒得动了').cls, '疲惫');
  assert.equal(classifyMood('提不起劲').cls, '疲惫');
  // 真的不爽才算烦
  assert.equal(classifyMood('名字被人拿去开玩笑，有点小不爽').cls, '烦');
});

// ── 热更新配置 ──────────────────────────────────────
test('live-config：白名单字段才生效，其余忽略', async () => {
  const { pickHotKeys } = await import('../src/live-config.js');
  const warns = [];
  const picked = pickHotKeys(
    { summarizeEvery: 1, dryRun: false, adapter: 'snowluma', merge: { perMinute: 2, windowMs: 500 } },
    (m) => warns.push(m),
  );
  assert.equal(picked.summarizeEvery, 1);
  assert.equal(picked.dryRun, false);
  assert.equal(picked.merge.perMinute, 2);
  assert.equal(picked.adapter, undefined, 'adapter 不许热改');
  assert.ok(warns.some((w) => w.includes('adapter')), '要告警说 adapter 需要重启');
});

test('live-config：文件改了自动重读', async () => {
  const { createLiveConfig } = await import('../src/live-config.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqkit-live-'));
  const file = path.join(dir, 'live.json');
  fs.writeFileSync(file, JSON.stringify({ summarizeEvery: 3 }), 'utf8');

  const live = createLiveConfig({ base: { summarizeEvery: 1, dryRun: false }, file });
  live.reload();
  assert.equal(live.current().summarizeEvery, 3, '文件值覆盖 base');

  // 改文件 → reload 后生效
  await new Promise((r) => setTimeout(r, 15));
  fs.writeFileSync(file, JSON.stringify({ summarizeEvery: 2, dryRun: true }), 'utf8');
  live.reload();
  assert.equal(live.current().summarizeEvery, 2);
  assert.equal(live.current().dryRun, true);
});

test('live-config：writePatch 只写跟 base 不同的部分', async () => {
  const { createLiveConfig } = await import('../src/live-config.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqkit-live2-'));
  const file = path.join(dir, 'live.json');

  const live = createLiveConfig({ base: { summarizeEvery: 1, dryRun: false, merge: { perMinute: 1 } }, file });
  live.writePatch({ summarizeEvery: 3, dryRun: false, merge: { perMinute: 2 } });
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.summarizeEvery, 3, '改了要写');
  assert.equal(written.dryRun, undefined, '没改的不写');
  assert.equal(written.merge.perMinute, 2);
});
