import test from 'node:test';
import assert from 'node:assert/strict';

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

test('loadPersona：读真实文件，core 比 full 小', async () => {
  // 发布版没有真实 soul.md，在临时目录造一个够长的样本
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqkit-persona-'));
  const file = path.join(dir, 'soul.md');
  fs.writeFileSync(
    file,
    `# SOUL

## 临场反应
${'被骂不回，被夸说6。\n'.repeat(40)}

## 一、你是谁
测试角色。

## 二、群聊说话铁律
${'短句。不用客服腔。\n'.repeat(60)}

## 三、随和守则
别上头。

## 十、AI 味黑名单
禁用客服腔。

## 十一、回复示例
"6"
`,
    'utf8',
  );
  const core = loadPersona({ path: file, mode: 'core' });
  const full = loadPersona({ path: file, mode: 'full' });
  assert.equal(core.mode, 'core');
  assert.equal(full.mode, 'full');
  assert.ok(core.bytes > 100, 'core 不能空');
  assert.ok(core.bytes < full.bytes, 'core 必须比全文小');
  assert.match(core.text, /临场反应/);
  assert.ok(core.text.includes('测试角色'));
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
