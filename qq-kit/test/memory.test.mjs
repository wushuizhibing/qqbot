import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadGroupMemory, loadKnownUsers, renderMemoryBlock, trimGroupMemory, relationshipOf, relationshipHint } from '../src/memory.js';
import { createStore } from '../src/storage.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqkit-'));

test('loadGroupMemory：读到群档案', () => {
  fs.writeFileSync(path.join(tmp, '100.md'), '# 群记忆\n- 甲：爱开玩笑\n', 'utf8');
  const text = loadGroupMemory({ memoryDir: tmp, chatId: '100' });
  assert.match(text, /爱开玩笑/);
});

test('loadGroupMemory：没有这个群是正常情况，不告警', () => {
  const warnings = [];
  const text = loadGroupMemory({ memoryDir: tmp, chatId: '999', warn: (m) => warnings.push(m) });
  assert.equal(text, '');
  assert.equal(warnings.length, 0);
});

test('loadGroupMemory：目录没配就返回空', () => {
  assert.equal(loadGroupMemory({ chatId: '1' }), '');
});

test('loadKnownUsers：只收有 nickname 的条目，openid 截后 6 位', () => {
  const file = path.join(tmp, 'known.json');
  fs.writeFileSync(
    file,
    JSON.stringify([
      { type: 'group', openid: 'ABCDEF123456', nickname: '群友甲' },
      { type: 'c2c', openid: 'ZZZZZZ999999' },
      { type: 'c2c', openid: 'QQQQQQ777777', nickname: '某人' },
    ]),
    'utf8',
  );
  const text = loadKnownUsers({ path: file });
  assert.match(text, /群友甲/);
  assert.match(text, /某人/);
  assert.match(text, /123456/);
  assert.ok(!text.includes('ZZZZZZ'), '没昵称的不进名单');
});

test('loadKnownUsers：文件不存在返回空', () => {
  assert.equal(loadKnownUsers({ path: path.join(tmp, 'nope.json') }), '');
  assert.equal(loadKnownUsers({}), '');
});

test('renderMemoryBlock：两个都有就拼起来，都没有就空串', () => {
  const both = renderMemoryBlock({ groupMemory: '群的事', knownUsers: '人的事' });
  assert.match(both, /这个群的记忆/);
  assert.match(both, /认识的人/);
  assert.equal(renderMemoryBlock({}), '');
});

test('trimGroupMemory：只留当前说话人的条目', () => {
  const memory = [
    '## 群里的人',
    '- **老友乙(100000002)**：爱起哄。',
    '- **3781492034(3781492034)**：泡在水里。',
    '- **3299455671(3299455671)**：手头紧。',
    '',
    '## 其它',
    '一些共通说明。',
  ].join('\n');

  const trimmed = trimGroupMemory(memory, ['100000002'], { maxOthers: 1 });
  assert.match(trimmed, /老友乙/);
  assert.match(trimmed, /一些共通说明/, '非人名段落原样保留');
  const personLines = trimmed.split('\n').filter((l) => /^\s*[-*]\s+\*\*/.test(l));
  assert.equal(personLines.length, 2, '1 个说话人 + 1 个补充，不能把所有人都带上');
  assert.ok(trimmed.length < memory.length, '必须真的变小');
});

test('trimGroupMemory：maxOthers=0 时只留说话人', () => {
  const memory = ['- **甲(111111)**：A', '- **乙(222222)**：B', '- **丙(333333)**：C'].join('\n');
  const trimmed = trimGroupMemory(memory, ['222222'], { maxOthers: 0 });
  assert.match(trimmed, /乙/);
  assert.ok(!trimmed.includes('甲'));
  assert.ok(!trimmed.includes('丙'));
});

test('trimGroupMemory：一个都对不上时原样返回，不清空记忆', () => {
  const memory = '- **甲(111111)**：A\n- **乙(222222)**：B';
  assert.equal(trimGroupMemory(memory, ['999999']), memory);
});

test('trimGroupMemory：没有活跃 ID 或空记忆都原样返回', () => {
  const memory = '- **甲(111111)**：A';
  assert.equal(trimGroupMemory(memory, []), memory);
  assert.equal(trimGroupMemory('', ['111111']), '');
});

test('store：写入后能跨实例读回（模拟重启）', () => {
  const file = path.join(tmp, 'summaries.json');
  const a = createStore({ file });
  a.set('group:100', { text: '在聊晚饭', facts: ['小A'] });
  a.save();

  const b = createStore({ file });
  const got = b.get('group:100');
  assert.equal(got.text, '在聊晚饭');
  assert.deepEqual(got.facts, ['小A']);
  assert.ok(got.updatedAt > 0);
});

test('store：文件损坏不抛错，当空库处理', () => {
  const file = path.join(tmp, 'broken.json');
  fs.writeFileSync(file, '{ 这不是 json', 'utf8');
  const warnings = [];
  const s = createStore({ file, warn: (m) => warnings.push(m) });
  assert.equal(s.get('x'), null);
  assert.equal(warnings.length, 1);
  // 还能继续写
  s.set('x', { text: 'ok' });
  s.save();
  assert.equal(createStore({ file }).get('x').text, 'ok');
});

test('store：没配文件也能用，只是不落盘', () => {
  const s = createStore({});
  s.set('k', { text: 'v' });
  assert.equal(s.get('k').text, 'v');
  s.save();
  assert.equal(s.size(), 1);
});

test('relationshipOf：主人 / 管理员 / 熟人 / 陌生人', () => {
  const memory = [
    '## 群里的人',
    '- **某人（QQ 123456789）**：主人，管着这摊事。',
    '- **老群友(100000003)**：常来的老群友，熟。',
    '- **管理员甲(1234567)**：群管理员，别抬杠。',
    '- **路人乙(7654321)**：偶尔来一下。',
  ].join('\n');

  assert.equal(relationshipOf(memory, '123456789'), 'owner');
  assert.equal(relationshipOf(memory, '1234567'), 'admin');
  assert.equal(relationshipOf(memory, '100000003'), 'friend');
  assert.equal(relationshipOf(memory, '7654321'), 'friend', '有记忆条目就算认识');
  assert.equal(relationshipOf(memory, '9999999'), 'stranger', '记忆里没有的人算陌生');
  assert.equal(relationshipOf(memory, ''), 'stranger');
  assert.equal(relationshipOf('', '123456789'), 'stranger');
});

test('relationshipOf：权限规则段里点到号也算', () => {
  const memory = [
    '## 我是谁',
    '**权限规则**：本群管理员是主人「某人」（QQ 123456789）。',
    '',
    '## 群里的人',
  ].join('\n');
  assert.equal(relationshipOf(memory, '123456789'), 'owner');
});

test('relationshipHint：四种关系各给一句态度', () => {
  assert.match(relationshipHint('owner'), /主人/);
  assert.match(relationshipHint('owner'), /亲/, '主人应该是最亲的人，不只是服从');
  assert.match(relationshipHint('admin'), /管理员/);
  assert.match(relationshipHint('friend'), /熟/);
  assert.match(relationshipHint('stranger'), /不熟/);
});

// ── 记忆星图：人物节点抽取 ──────────────────────────
test('collectPeople：两种记忆写法都能抽出人', async () => {
  const { collectPeople } = await import('../src/people.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqkit-people-'));
  fs.writeFileSync(
    path.join(dir, '100.md'),
    [
      '## 群里的人',
      '- **主人甲（QQ 123456789）**：主人，管着这摊事。',
      '- **老友乙**（旧 openid `BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`）：熟，爱开玩笑。',
      '- **新人丙(1234567)**：偶尔来。',
      '- **1234567(1234567)**：纯数字名，应该被跳过。',
    ].join('\n'),
    'utf8',
  );
  const list = collectPeople({ memoryDir: dir, chatIds: ['100'] });
  const names = list.map((p) => p.name);
  assert.ok(names.includes('主人甲'), '星号内的号要认');
  assert.ok(names.includes('老友乙'), '星号外的 openid 也要认');
  assert.ok(!names.some((n) => /^\d+$/.test(n)), '纯数字名不该成为节点');
  // 主人亲近度拉满
  const owner = list.find((p) => p.relation === 'owner');
  assert.ok(owner, '要能识别主人');
  assert.equal(owner.warmth, 1, '主人亲近度应为 1');
});

test('collectPeople：同一个人在两个群只出一个节点，群归属累加', async () => {
  const { collectPeople, relationSummary } = await import('../src/people.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqkit-people2-'));
  const line = '- **某人(123456789)**：主人。';
  fs.writeFileSync(path.join(dir, '1.md'), line, 'utf8');
  fs.writeFileSync(path.join(dir, '2.md'), line, 'utf8');
  const list = collectPeople({ memoryDir: dir, chatIds: ['1', '2'] });
  const node = list.find((p) => p.id === '123456789');
  assert.ok(node, '要有这个节点');
  assert.equal(list.filter((p) => p.id === '123456789').length, 1, '同一个号只出一个节点');
  assert.deepEqual(node.groups.sort(), ['1', '2'], '两个群的归属都要记下');
  assert.equal(relationSummary(list).owner, 1, '主人只能算一个');
});

test('collectPeople：名字相同、号码不同（openid 版 + QQ 号版）合并成一个', async () => {
  const { collectPeople } = await import('../src/people.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqkit-people5-'));
  fs.writeFileSync(
    path.join(dir, '1.md'),
    [
      '- **老友乙**（`AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`）：老档案记的 openid。',
      '- **老友乙(100000002)**：这个 QQ 就是本人。',
    ].join('\n'),
    'utf8',
  );
  const list = collectPeople({ memoryDir: dir, chatIds: ['1'] });
  const jml = list.filter((p) => p.name === '老友乙');
  assert.equal(jml.length, 1, '同名的两条要合并');
  assert.equal(jml[0].id, '100000002', '合并后要用真 QQ 号，不用 openid');
});

test('collectPeople：不要把 openid 里的数字片段当 QQ 号', async () => {
  const { collectPeople } = await import('../src/people.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqkit-people6-'));
  // openid 里含 415338，但不是 QQ 号
  fs.writeFileSync(path.join(dir, '1.md'), '- **老友丙**（`BA415338CBCD0FF161F0F33CFA82EC6B`）：话少。', 'utf8');
  const list = collectPeople({ memoryDir: dir, chatIds: ['1'] });
  assert.equal(list.length, 1);
  assert.notEqual(list[0].id, '415338', '不能把 openid 的数字片段当号');
  assert.ok(list[0].id.startsWith('BA415338') || list[0].id.startsWith('name:'), '应该用完整 openid 或名字');
});

test('collectPeople：没写 QQ 号的人也能出节点（早期群档案）', async () => {
  const { collectPeople } = await import('../src/people.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqkit-people3-'));
  fs.writeFileSync(
    path.join(dir, '9.md'),
    ['- **甲**：活跃。', '- **乙**：话少。'].join('\n'),
    'utf8',
  );
  const list = collectPeople({ memoryDir: dir, chatIds: ['9'] });
  assert.equal(list.length, 2, '两个人两个节点');
  assert.ok(list.every((p) => p.id && p.id.startsWith('name:')), '没号时用名字当标识');
});

test('relationSummary：按关系计数', async () => {
  const { relationSummary } = await import('../src/people.js');
  const s = relationSummary([{ relation: 'owner' }, { relation: 'friend' }, { relation: 'friend' }]);
  assert.equal(s.owner, 1);
  assert.equal(s.friend, 2);
  assert.equal(s.stranger, 0);
});

test('collectPeople：群记忆里的「风格」「其它」不该被当成人', async () => {
  const { collectPeople } = await import('../src/people.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqkit-people4-'));
  fs.writeFileSync(
    path.join(dir, '1.md'),
    [
      '## 群里的人',
      '- **某人(123456789)**：主人。',
      '## 其它',
      '- **风格**：主人会直接在群里贴图吐槽。',
      '- **其它**：机器人掉线是老毛病。',
    ].join('\n'),
    'utf8',
  );
  const list = collectPeople({ memoryDir: dir, chatIds: ['1'] });
  const names = list.map((p) => p.name);
  assert.ok(names.includes('某人'), '真正的人要在');
  assert.ok(!names.includes('风格'), '「风格」是段落不是人');
  assert.ok(!names.includes('其它'), '「其它」是段落不是人');
});
