import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectPeople, relationSummary } from '../src/people.js';
import { relationshipOf, relationshipHint, relationRank } from '../src/relationship.js';
import { createMoodState } from '../src/core.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moodkit-people-'));
const mkdir = () => path.join(tmp, `d-${Math.random().toString(16).slice(2)}`);

// ── 关系判定 ──────────────────────────────────────
test('relationshipOf：主人 / 管理员 / 熟人 / 陌生', () => {
  const memory = [
    '## 群里的人',
    '- **某人（QQ 123456789）**：主人，管着这摊事。',
    '- **老群友(100000003)**：常来的老群友。',
    '- **管理员甲(1234567)**：群管理员，别抬杠。',
    '- **路人乙(7654321)**：偶尔来一下。',
  ].join('\n');
  assert.equal(relationshipOf(memory, '123456789'), 'owner');
  assert.equal(relationshipOf(memory, '1234567'), 'admin');
  assert.equal(relationshipOf(memory, '100000003'), 'friend');
  assert.equal(relationshipOf(memory, '9999999'), 'stranger');
  assert.equal(relationshipOf(memory, ''), 'stranger');
});

test('relationshipOf：认 32 位 openid', () => {
  const memory = '- **某人**（旧 openid `BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`）：熟。';
  assert.equal(relationshipOf(memory, 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'), 'friend');
});

test('relationshipOf：name: 前缀按名字对', () => {
  const memory = '- **群友己zzz**：活跃。';
  assert.equal(relationshipOf(memory, 'name:群友己zzz'), 'friend');
});

test('relationshipHint：四种关系各给一句', () => {
  assert.match(relationshipHint('owner'), /主人/);
  assert.match(relationshipHint('owner'), /亲/, '主人是最亲的人');
  assert.match(relationshipHint('admin'), /管理员/);
  assert.match(relationshipHint('friend'), /熟/);
  assert.match(relationshipHint('stranger'), /不熟/);
});

test('relationRank：主人最高', () => {
  assert.ok(relationRank('owner') > relationRank('admin'));
  assert.ok(relationRank('admin') > relationRank('friend'));
  assert.ok(relationRank('friend') > relationRank('stranger'));
});

// ── 人物抽取 ──────────────────────────────────────
test('collectPeople：两种记忆写法都能抽出人', () => {
  const dir = mkdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '100.md'),
    [
      '- **主人甲（QQ 123456789）**：主人。',
      '- **老友乙**（旧 openid `BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`）：熟。',
      '- **新人丙(1234567)**：偶尔来。',
      '- **1234567(1234567)**：纯数字名，应跳过。',
    ].join('\n'),
    'utf8',
  );
  const list = collectPeople({ memoryDir: dir, chatIds: ['100'] });
  const names = list.map((p) => p.name);
  assert.ok(names.includes('主人甲'));
  assert.ok(names.includes('老友乙'));
  assert.ok(!names.some((n) => /^\d+$/.test(n)));
  const owner = list.find((p) => p.relation === 'owner');
  assert.equal(owner.warmth, 1, '主人亲近度拉满');
});

test('collectPeople：群记忆里的「风格」「其它」不该被当成人', () => {
  const dir = mkdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '1.md'),
    ['- **某人(123456789)**：主人。', '- **风格**：主人会贴图吐槽。', '- **其它**：掉线是老毛病。'].join('\n'),
    'utf8',
  );
  const names = collectPeople({ memoryDir: dir, chatIds: ['1'] }).map((p) => p.name);
  assert.ok(names.includes('某人'));
  assert.ok(!names.includes('风格'));
  assert.ok(!names.includes('其它'));
});

test('collectPeople：梗名/事件条目也不算人', () => {
  const dir = mkdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '1.md'),
    ['- **某人(123456789)**：主人。', '- **和某某的「追不上」梗**（最重的一条）：他说别忘记我。'].join('\n'),
    'utf8',
  );
  const names = collectPeople({ memoryDir: dir, chatIds: ['1'] }).map((p) => p.name);
  assert.ok(!names.some((n) => n.includes('梗')), `不该把梗当人: ${names.join(',')}`);
});

test('collectPeople：同一个人在两个群只出一个节点，群归属累加', () => {
  const dir = mkdir();
  fs.mkdirSync(dir, { recursive: true });
  const line = '- **某人(123456789)**：主人。';
  fs.writeFileSync(path.join(dir, '1.md'), line, 'utf8');
  fs.writeFileSync(path.join(dir, '2.md'), line, 'utf8');
  const list = collectPeople({ memoryDir: dir, chatIds: ['1', '2'] });
  const node = list.find((p) => p.id === '123456789');
  assert.equal(list.filter((p) => p.id === '123456789').length, 1, '只出一个节点');
  assert.deepEqual(node.groups.sort(), ['1', '2']);
  assert.equal(relationSummary(list).owner, 1);
});

test('collectPeople：名字相同、号码不同合并成一个（用真 QQ 号）', () => {
  const dir = mkdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '1.md'),
    ['- **老友乙**（`AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`）：老档案。', '- **老友乙(100000002)**：就是本人。'].join('\n'),
    'utf8',
  );
  const list = collectPeople({ memoryDir: dir, chatIds: ['1'] });
  const jml = list.filter((p) => p.name === '老友乙');
  assert.equal(jml.length, 1, '同名的合并');
  assert.equal(jml[0].id, '100000002', '优先用数字 QQ 号');
});

test('collectPeople：不要把 openid 里的数字片段当 QQ 号', () => {
  const dir = mkdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '1.md'), '- **老友丙**（`BA415338CBCD0FF161F0F33CFA82EC6B`）：话少。', 'utf8');
  const list = collectPeople({ memoryDir: dir, chatIds: ['1'] });
  assert.equal(list.length, 1);
  assert.notEqual(list[0].id, '415338', 'openid 数字片段不是 QQ 号');
});

test('collectPeople：没写号的人也能出节点', () => {
  const dir = mkdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '9.md'), ['- **甲**：活跃。', '- **乙**：话少。'].join('\n'), 'utf8');
  const list = collectPeople({ memoryDir: dir, chatIds: ['9'] });
  assert.equal(list.length, 2);
  assert.ok(list.every((p) => p.id.startsWith('name:')));
});

// ── 中枢 API ──────────────────────────────────────
test('createMoodState：observe 拦照抄、限沿用、放大、落盘', () => {
  const file = path.join(tmp, 'state.json');
  const st = createMoodState({ file });

  const r1 = st.observe({ sessionKey: 'g:1', mood: '被老王连怼，有点不爽', intensity: 4 });
  assert.equal(r1.mood, '被老王连怼，有点不爽');
  assert.ok(r1.intensity >= 5, `强度要放大，实际 ${r1.intensity}`);
  assert.equal(r1.classification, '烦');

  // 照抄上一轮 → 当作没给新情绪，走沿用
  const r2 = st.observe({ sessionKey: 'g:1', mood: '被老王连怼，有点不爽', intensity: 4 });
  assert.equal(r2.carried, 1, '被判定成沿用');
  assert.ok(r2.intensity < r1.intensity, '沿用期间强度下降');

  // 连续空 → 两轮后清空
  st.observe({ sessionKey: 'g:1', mood: '', intensity: 0 });
  const r4 = st.observe({ sessionKey: 'g:1', mood: '', intensity: 0 });
  assert.equal(r4.mood, '', '沿用上限后清空');
  assert.equal(r4.intensity, 0);

  // 落盘：新实例能读回历史
  const st2 = createMoodState({ file });
  assert.ok(st2.points().length >= 1, '历史要能读回');
});

test('createMoodState：stats 支持字符串和对象两种调法', () => {
  const st = createMoodState({ file: path.join(tmp, 'stats.json') });
  st.observe({ sessionKey: 'g:1', mood: '有点烦', intensity: 3 });
  assert.ok(st.stats('day').ratio);
  assert.ok(st.stats({ window: 'all' }).ratio);
  const all = st.stats();
  assert.ok(all.all && all.day && all.hour, '不传返回三窗口');
});

test('createMoodState：people 传给底层的 memoryDir', () => {
  const dir = mkdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '1.md'), '- **甲(123456789)**：主人。', 'utf8');
  const st = createMoodState({ file: path.join(tmp, 'ppl.json'), memoryDir: dir });
  const p = st.people({ chatIds: ['1'] });
  assert.equal(p.nodes.length, 1);
  assert.equal(p.summary.owner, 1);
});

test('collectPeople：不给 chatIds 时自动扫目录', () => {
  const dir = mkdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '111.md'), '- **甲(123456789)**：主人。', 'utf8');
  fs.writeFileSync(path.join(dir, '222.md'), '- **乙(1234567)**：熟。', 'utf8');
  fs.writeFileSync(path.join(dir, 'note.md'), '- **丙(7654321)**：不是群号文件，应忽略。', 'utf8');
  const list = collectPeople({ memoryDir: dir });
  assert.equal(list.length, 2, '只扫数字命名的群记忆');
  assert.deepEqual(list.map((p) => p.name).sort(), ['乙', '甲']);
});

// ── 面板数据供给 ──────────────────────────────────
test('panel-hub：注册、收集、注销', async () => {
  const { createPanelHub } = await import('../src/panel-hub.js');
  const hub = createPanelHub();
  assert.deepEqual(hub.collect(), {}, '没注册时是空对象');

  const d1 = hub.contribute('qq', () => ({ sessions: [1, 2] }));
  const d2 = hub.contribute('wx', () => ({ sessions: [] }));
  const got = hub.collect();
  assert.deepEqual(got.qq.sessions, [1, 2]);
  assert.deepEqual(got.wx.sessions, []);
  assert.equal(got.qq._canApply, false, '没传 apply 就不支持调参');
  assert.deepEqual(hub.ids().sort(), ['qq', 'wx']);

  d1();
  assert.equal(hub.collect().qq, undefined, '注销后不再收集');
  d2();
  assert.deepEqual(hub.collect(), {});
});

test('panel-hub：单个供给方抛错不能拖垮整体', async () => {
  const { createPanelHub } = await import('../src/panel-hub.js');
  const warns = [];
  const hub = createPanelHub({ warn: (m) => warns.push(m) });
  hub.contribute('bad', () => {
    throw new Error('炸了');
  });
  hub.contribute('good', () => ({ ok: true }));
  const got = hub.collect();
  assert.equal(got.good.ok, true, '好的照常收集');
  assert.equal(got.bad, undefined, '坏的不进结果');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /bad/);
});

test('panel-hub：带 apply 的供给方能接调参', async () => {
  const { createPanelHub } = await import('../src/panel-hub.js');
  const hub = createPanelHub();
  let received = null;
  hub.contribute('qq', {
    data: () => ({ config: { dryRun: false } }),
    apply: (patch) => {
      received = patch;
      return { ok: true, applied: patch };
    },
  });
  assert.equal(hub.collect().qq._canApply, true, '面板要知道这个能调');
  const out = hub.apply('qq', { dryRun: true });
  assert.deepEqual(received, { dryRun: true });
  assert.equal(out.applied.dryRun, true);
  // 不存在的供给方 / 不支持调参的供给方
  assert.throws(() => hub.apply('nope', {}), /没有这个供给方/);
  hub.contribute('plain', () => ({}));
  assert.throws(() => hub.apply('plain', {}), /不支持在线调参/);
});

test('panel-hub：供给方返回 null/undefined 时跳过', async () => {
  const { createPanelHub } = await import('../src/panel-hub.js');
  const hub = createPanelHub();
  hub.contribute('a', () => null);
  hub.contribute('b', () => undefined);
  assert.deepEqual(hub.collect(), {});
});
