import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  locatePeopleSection,
  parsePeopleSection,
  cleanImpression,
  mergeImpressions,
  writeMemoryFile,
  pickPeopleToUpdate,
  IMPRESSION_MAX,
} from '../src/impressions.js';
import {
  renderTranscript,
  buildImpressionPrompt,
  parseImpressionReply,
  createImpressionDistiller,
} from '../src/impression-distill.js';

const MEMORY = `# 群记忆 · 123

## 我是谁
一条鲸鱼娘。

**权限规则**：主人是某人（QQ 123456789）。

## 群里的人
> 认人按 QQ 号，不按昵称。
- **某人（QQ 123456789）**：主人，管着这摊事。
- **老王（QQ 100000001）**：话多，爱起哄。

## 其它
- **风格**：群里爱玩梗。
`;

test('locatePeopleSection：只框住「群里的人」这一段', () => {
  const r = locatePeopleSection(MEMORY);
  assert.ok(r, '要找到这一节');
  const lines = MEMORY.split('\n');
  assert.match(lines[r.headerIndex], /群里的人/);
  // 段尾应该是下一个 ## 标题
  assert.match(lines[r.end], /## 其它/);
});

test('parsePeopleSection：抽出名字和号', () => {
  const people = parsePeopleSection(MEMORY);
  assert.equal(people.length, 2);
  assert.equal(people[0].name, '某人');
  assert.equal(people[0].id, '123456789');
  assert.equal(people[1].name, '老王');
});

test('cleanImpression：压成一行并限长', () => {
  assert.equal(cleanImpression('爱\n起哄'), '爱 起哄');
  assert.equal(cleanImpression('「话多」'), '话多');
  assert.ok(cleanImpression('x'.repeat(200)).length <= IMPRESSION_MAX);
  assert.equal(cleanImpression(''), '');
});

test('mergeImpressions：已有人只换印象，头部（昵称+号）保留', () => {
  const out = mergeImpressions(MEMORY, [{ name: '老王', impression: '话变少了，更爱发表情' }]);
  assert.match(out, /- \*\*老王（QQ 100000001）\*\*：话变少了，更爱发表情/, '要保留原来的昵称和 QQ 号');
  assert.ok(!out.includes('爱起哄'), '旧印象要被换掉');
});

test('mergeImpressions：新人插在列表末尾，不串到下一节', () => {
  const out = mergeImpressions(MEMORY, [{ name: '新人甲', id: '200000001', impression: '话少，爱发表情' }]);
  const lines = out.split('\n');
  const newLine = lines.findIndex((l) => l.includes('新人甲'));
  const otherLine = lines.findIndex((l) => /^## 其它/.test(l));
  assert.ok(newLine > 0 && otherLine > 0, '都要有');
  assert.ok(newLine < otherLine, '新人要插在「群里的人」段内，不能跑到「其它」下面');
  assert.match(lines[newLine], /QQ 200000001/, '带号');
});

test('mergeImpressions：段外内容一个字都不能动', () => {
  const out = mergeImpressions(MEMORY, [
    { name: '老王', impression: '新印象' },
    { name: '新人乙', impression: '刚来' },
  ]);
  // 权限规则、我是谁、其它 都要原样
  assert.ok(out.includes('**权限规则**：主人是某人（QQ 123456789）。'));
  assert.ok(out.includes('一条鲸鱼娘。'));
  assert.ok(out.includes('- **风格**：群里爱玩梗。'));
});

test('mergeImpressions：没有「群里的人」这一节就不乱动', () => {
  const noSection = '# 群记忆\n\n## 我是谁\n鲸鱼。\n';
  assert.equal(mergeImpressions(noSection, [{ name: '甲', impression: '乙' }]), noSection);
});

test('mergeImpressions：空更新、空印象都跳过', () => {
  assert.equal(mergeImpressions(MEMORY, []), MEMORY);
  assert.equal(mergeImpressions(MEMORY, [{ name: '', impression: 'x' }]), MEMORY);
  assert.equal(mergeImpressions(MEMORY, [{ name: '老王', impression: '' }]), MEMORY);
});

test('writeMemoryFile：写之前备份，原子写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impressions-'));
  const file = path.join(dir, '123.md');
  fs.writeFileSync(file, MEMORY, 'utf8');
  const { backup } = writeMemoryFile(file, MEMORY + '\n新内容');
  assert.ok(fs.existsSync(backup), '备份要真的生成');
  assert.equal(fs.readFileSync(backup, 'utf8'), MEMORY, '备份是改动前的内容');
  assert.match(fs.readFileSync(file, 'utf8'), /新内容/);
  assert.ok(!fs.existsSync(file + '.tmp'), '临时文件不该留下');
});

test('pickPeopleToUpdate：说话多的优先，没有号的忽略', () => {
  const records = [
    { sender: '甲', senderId: '1' },
    { sender: '甲', senderId: '1' },
    { sender: '乙', senderId: '2' },
    { sender: '无名', senderId: '' }, // 没号，跳过
  ];
  const picked = pickPeopleToUpdate(records, 5);
  assert.equal(picked[0].name, '甲');
  assert.equal(picked[0].count, 2);
  assert.equal(picked.length, 2);
});

// ── 提炼层 ──────────────────────────────────
test('renderTranscript：压成一行一条', () => {
  const s = renderTranscript([
    { sender: '甲', text: '多行\n内容' },
    { sender: '乙', text: '' }, // 空的跳过
  ]);
  assert.equal(s, '甲: 多行 内容');
});

test('buildImpressionPrompt：要求写特征而不是事件', () => {
  const p = buildImpressionPrompt(['甲'], '甲: 你好', '');
  assert.match(p, /是什么样/, '要写性格特征');
  assert.match(p, /不要写具体事件/, '明确禁止流水式描述');
  assert.match(p, /只输出 JSON/, '要有格式约束');
});

test('parseImpressionReply：抠出 people，丢掉空的和"不知道"', () => {
  const reply = JSON.stringify({
    people: [
      { name: '甲', impression: '爱起哄' },
      { name: '乙', impression: '不知道' },
      { name: '', impression: '空的' },
      { name: '丙', impression: 'x'.repeat(200) },
    ],
  });
  const got = parseImpressionReply(reply);
  assert.equal(got.length, 2, '只有甲和丙有效');
  assert.ok(got.find((p) => p.name === '丙').impression.length <= IMPRESSION_MAX, '要限长');
});

test('createImpressionDistiller：端到端（假 agents）', async () => {
  const distiller = createImpressionDistiller(
    {
      agents: {
        runOnce: async () => JSON.stringify({ people: [{ name: '甲', impression: '话多爱起哄' }] }),
      },
    },
    {},
  );
  const got = await distiller.distill({ names: ['甲'], records: [{ sender: '甲', text: '哈哈哈' }] });
  assert.equal(got.length, 1);
  assert.equal(got[0].impression, '话多爱起哄');
});

test('createImpressionDistiller：没素材/没名字时不调模型', async () => {
  let called = 0;
  const distiller = createImpressionDistiller(
    { agents: { runOnce: async () => { called += 1; return '{}'; } } },
    {},
  );
  assert.deepEqual(await distiller.distill({ names: [], records: [{ sender: '甲', text: 'x' }] }), []);
  assert.deepEqual(await distiller.distill({ names: ['甲'], records: [] }), []);
  assert.equal(called, 0, '不该白调一次模型');
});

test('mergeImpressions：同名的两条要按号区分，别改错那条', () => {
  // 真实记忆里同一个昵称可能挂两条（老 openid 版 + 新 QQ 号版）
  const mem = [
    '# 群记忆',
    '',
    '## 群里的人',
    '- **老友乙**（`AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD`）：老档案记的。',
    '- **老友乙（QQ 100000002）**：新档案记的。',
    '',
    '## 其它',
    'x',
  ].join('\n');

  const out = mergeImpressions(mem, [
    { name: '老友乙', id: '100000002', impression: '只该更新带 QQ 号那条' },
  ]);
  assert.match(out, /老档案记的/, 'openid 那条不该被改');
  assert.match(out, /\*\*老友乙（QQ 100000002）\*\*：只该更新带 QQ 号那条/, '带号那条被改');
});

test('mergeImpressions：模型只给名字没给号时，退回按名字找', () => {
  const mem = ['# 群', '', '## 群里的人', '- **老王（QQ 100000001）**：话多。', '', '## 其它', 'x'].join('\n');
  const out = mergeImpressions(mem, [{ name: '老王', impression: '话变少了' }]);
  assert.match(out, /\*\*老王（QQ 100000001）\*\*：话变少了/, '按名字也能找到，且保留原号');
});

test('mergeImpressions：同一轮里不会对同一条改两次', () => {
  const mem = ['# 群', '', '## 群里的人', '- **老王（QQ 100000001）**：旧。', '', '## 其它', 'x'].join('\n');
  const out = mergeImpressions(mem, [
    { name: '老王', impression: '第一次' },
    { name: '老王', id: '100000001', impression: '第二次' },
  ]);
  // 后一条覆盖前一条，但只产生一行
  const hits = out.split('\n').filter((l) => l.includes('老王'));
  assert.equal(hits.length, 1, '不该变成两行');
  assert.match(out, /第二次/);
});

// ── 新人实时建档 ──────────────────────────────────
test('hasPersonEntry：按号优先，按名字兜底', async () => {
  const { hasPersonEntry } = await import('../src/impressions.js');
  assert.equal(hasPersonEntry(MEMORY, { name: '老王', id: '100000001' }), true, '有号也对得上');
  assert.equal(hasPersonEntry(MEMORY, { name: '瞎写的', id: '100000001' }), true, '号对就行，名字随便');
  assert.equal(hasPersonEntry(MEMORY, { name: '老王', id: '999' }), true, '号不对但名字对');
  assert.equal(hasPersonEntry(MEMORY, { name: '路人', id: '888' }), false, '真的没有');
});

test('addPersonEntry：新人建档，只写名字和号，印象留占位', async () => {
  const { addPersonEntry } = await import('../src/impressions.js');
  const { memory, added } = addPersonEntry(MEMORY, { name: '新来的', id: '300000001' });
  assert.equal(added, true);
  assert.match(memory, /- \*\*新来的（QQ 300000001）\*\*：/, '要带名字和号');

  const lines = memory.split('\n');
  const idxNew = lines.findIndex((l) => l.includes('新来的'));
  const idxOther = lines.findIndex((l) => /^## 其它/.test(l));
  assert.ok(idxNew > 0 && idxNew < idxOther, '要插在「群里的人」段内');
});

test('addPersonEntry：已有的人不重复建', async () => {
  const { addPersonEntry } = await import('../src/impressions.js');
  const r = addPersonEntry(MEMORY, { name: '老王', id: '100000001' });
  assert.equal(r.added, false);
  assert.equal(r.memory, MEMORY, '一个字都不该动');
});

test('addPersonEntry：纯数字昵称要给个能读的显示名', async () => {
  const { addPersonEntry } = await import('../src/impressions.js');
  // 协议端有时只给 QQ 号当昵称
  const { memory } = addPersonEntry(MEMORY, { name: '7654321', id: '7654321' });
  assert.match(memory, /群友4321/, '不能直接拿纯数字当名字');
});

test('addPersonEntry：段落满了就不再加', async () => {
  const { addPersonEntry } = await import('../src/impressions.js');
  // MEMORY 里有 2 个人，limit 设 2 应该加不进去
  const r = addPersonEntry(MEMORY, { name: '溢出的', id: '400000001' }, 2);
  assert.equal(r.added, false);
});

test('addPersonEntry：没有「群里的人」段就不乱加', async () => {
  const { addPersonEntry } = await import('../src/impressions.js');
  const noSection = '# 群\n\n## 我是谁\n鲸鱼。\n';
  const r = addPersonEntry(noSection, { name: '甲', id: '1' });
  assert.equal(r.added, false);
  assert.equal(r.memory, noSection);
});
