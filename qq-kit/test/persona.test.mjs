import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { splitSections, extractCorePersona, loadPersona, FALLBACK_PERSONA } from '../src/persona.js';

const SAMPLE = `# SOUL.md

## 临场反应
被骂不回。

## 一、你是谁
测试角色。

## 二、群聊说话铁律
短句。

## 三、随和守则
别上头。

## 十、AI 味黑名单
禁用客服腔。

## 十一、回复示例
"6"
`;

test('splitSections 按二级标题切段', () => {
  const s = splitSections(SAMPLE);
  // 文件开头（一级标题 + 空行）会作为无标题的首段返回，这是预期行为
  const heads = s.map((x) => x.heading).filter(Boolean);
  assert.equal(heads[0], '## 临场反应');
  assert.ok(heads.length >= 6);
});

test('extractCorePersona 只留核心几节', () => {
  const core = extractCorePersona(SAMPLE);
  assert.match(core, /被骂不回/);
  assert.match(core, /测试角色/);
  assert.match(core, /短句/);
  assert.match(core, /禁用客服腔/);
  assert.ok(!core.includes('别上头'), '非核心章节应被裁掉');
  assert.ok(!core.includes('随和守则'));
});

test('loadPersona：读真实文件，core 比 full 小', () => {
  const path = 'C:/path/to/persona/soul.md';
  if (!fs.existsSync(path)) return; // 发布版没有这个文件
  const core = loadPersona({ path, mode: 'core' });
  const full = loadPersona({ path, mode: 'full' });
  assert.equal(core.mode, 'core');
  assert.equal(full.mode, 'full');
  assert.ok(core.bytes > 3000, `core 只有 ${core.bytes} 字节，八成标题没匹配上`);
  assert.ok(core.bytes < full.bytes, 'core 必须比全文小');
  // 标题会改，这里只查内容而不是标题字面
  assert.ok(core.text.includes('测试角色'), 'core 里要有身份');
});

test('loadPersona：文件不存在时退回内置人格并告警', () => {
  const warnings = [];
  const p = loadPersona({ path: 'C:/definitely/not/here.md', warn: (m) => warnings.push(m) });
  assert.equal(p.mode, 'fallback');
  assert.equal(p.text, FALLBACK_PERSONA);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /读取人格文件失败/);
});

test('loadPersona：没给路径直接用内置', () => {
  const p = loadPersona({});
  assert.equal(p.mode, 'fallback');
  assert.match(p.text, /NO_REPLY/);
});

// ── core 章节匹配不能靠死标题 ────────────────────
test('extractCorePersona：标题改了也不丢关键章节', () => {
  // 真实事故：soul.md 重写后「二、群聊说话铁律」改成「二、怎么说话」，
  // 写死的标题数组 5 个里只对上 1 个，每轮只带「你是谁」一小段，
  // 骂人/说话/示例全丢，且没有任何报错。
  const soul = [
    '## 零、最要紧的一条',
    '你有骨头，不当沙包。',
    '## 一、你是谁',
    '测试角色。',
    '## 二、怎么说话',
    '一句话能说完就别用两句。',
    '## 四之二、骂人这件事',
    '轻怼：你没事吧。',
    '## 九、AI 味黑名单',
    '首先其次最后。',
    '## 十、回复示例',
    '上号 → 来了来了。',
    '## 五、发图',
    '默认不发。',
  ].join('\n\n');

  const core = extractCorePersona(soul);
  assert.match(core, /有骨头/, '「最要紧的一条」要带上');
  assert.match(core, /测试角色/, '「你是谁」要带上');
  assert.match(core, /一句话能说完/, '说话铁律要带上');
  assert.match(core, /轻怼/, '骂人那一节要带上');
  assert.match(core, /首先其次最后/, 'AI 味黑名单要带上');
  assert.match(core, /来了来了/, '回复示例要带上');
  assert.ok(!core.includes('默认不发'), '发图那节不进 core');
});

test('extractCorePersona：新版 soul.md 的 core 够长', () => {
  // 太短说明又漏章节了（之前只有 612 字节，因为只匹配上一节）
  const fs2 = fs;
  const soulPath = 'C:/path/to/persona/soul.md';
  if (!fs2.existsSync(soulPath)) return; // 发布版没有这个文件
  const p = loadPersona({ path: soulPath, mode: 'core' });
  assert.ok(p.bytes > 3000, `core 只有 ${p.bytes} 字节，八成又没匹配上章节`);
});
