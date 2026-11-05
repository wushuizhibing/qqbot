import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  splitEntry,
  nameOfHead,
  renameEntry,
  renameInMemory,
  writeMemorySafely,
} from '../src/rename.js';

const MEM = [
  '# 群记忆',
  '',
  '## 群里的人',
  '',
  '- **某人（QQ 123456789）**：主人，群管理员。掌着这摊事。',
  '- **老王（QQ 100000001）**：话多爱起哄。',
  '- **某甲**（`BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`）：技术底子好。',
  '',
  '## 群文化',
  '',
  '- 早上打卡',
].join('\n');

test('splitEntry：号在星号里 / 号在星号外 都能拆', () => {
  const a = splitEntry('- **老王（QQ 100000001）**：话多');
  assert.equal(a.head, '- **老王（QQ 100000001）**');
  assert.equal(a.body, '话多');

  const b = splitEntry('- **某甲**（`BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`）：技术好');
  assert.match(b.head, /^- \*\*某甲\*\*（`BBBB/);
  assert.equal(b.body, '技术好');
});

test('nameOfHead：去掉括号里的号', () => {
  assert.equal(nameOfHead('- **老王（QQ 100000001）**'), '老王');
  assert.equal(nameOfHead('- **某甲**'), '某甲');
});

test('renameEntry：QQ 号形式，改名后号还在', () => {
  const out = renameEntry('- **老王（QQ 100000001）**：话多', '王哥');
  assert.equal(out, '- **王哥（QQ 100000001）**：话多');
});

test('renameEntry：openid 形式，改名后括号还在、不多冒号', () => {
  const out = renameEntry('- **某甲**（`BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`）：技术好', '甲哥');
  assert.equal(out, '- **甲哥**（`BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`）：技术好');
});

test('renameEntry：名字没变就原样返回', () => {
  const line = '- **老王（QQ 100000001）**：话多';
  assert.equal(renameEntry(line, '老王'), line);
});

test('renameEntry：纯数字名不采用（那是占位）', () => {
  const line = '- **老王（QQ 100000001）**：话多';
  assert.equal(renameEntry(line, '123456'), line);
});

test('renameEntry：空名字不采用', () => {
  const line = '- **老王（QQ 100000001）**：话多';
  assert.equal(renameEntry(line, '  '), line);
});

test('renameInMemory：按 QQ 号找到人并改名', () => {
  const { memory, changed } = renameInMemory(MEM, '100000001', '王哥');
  assert.equal(changed, true);
  assert.match(memory, /- \*\*王哥（QQ 100000001）\*\*：话多爱起哄。/);
  assert.ok(!memory.includes('老王'), '旧名字该没了');
});

test('renameInMemory：按 openid 也能找到', () => {
  const { memory, changed } = renameInMemory(MEM, 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', '甲哥');
  assert.equal(changed, true);
  assert.match(memory, /\*\*甲哥\*\*（`BBBBBB/);
});

test('renameInMemory：印象一个字不动', () => {
  const { memory } = renameInMemory(MEM, '123456789', '主人');
  assert.match(memory, /：主人，群管理员。掌着这摊事。/);
});

test('renameInMemory：「群里的人」段外一个字不动', () => {
  const { memory } = renameInMemory(MEM, '100000001', '王哥');
  const tail = (s) => s.slice(s.indexOf('## 群文化'));
  assert.equal(tail(memory), tail(MEM));
});

test('renameInMemory：找不到号就不改', () => {
  const { memory, changed } = renameInMemory(MEM, '999999999', '陌生人');
  assert.equal(changed, false);
  assert.equal(memory, MEM);
});

test('renameInMemory：没有「群里的人」这一节就跳过', () => {
  const plain = '# 群记忆\n\n## 群文化\n- 打卡\n';
  const { changed } = renameInMemory(plain, '100000001', '王哥');
  assert.equal(changed, false);
});

test('writeMemorySafely：备份 + 原子写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-'));
  const file = path.join(dir, '200000001.md');

  const r1 = writeMemorySafely(file, '# 一\n');
  assert.equal(r1.backup, null, '第一次没有备份');
  assert.equal(fs.readFileSync(file, 'utf8'), '# 一\n');

  const r2 = writeMemorySafely(file, '# 二\n');
  assert.ok(r2.backup && fs.existsSync(r2.backup), '第二次要备份');
  assert.equal(fs.readFileSync(file, 'utf8'), '# 二\n');
  assert.equal(fs.readFileSync(r2.backup, 'utf8'), '# 一\n', '备份是改之前的内容');
  assert.ok(!fs.existsSync(`${file}.tmp-${process.pid}`), '不能留临时文件');

  fs.rmSync(dir, { recursive: true, force: true });
});
