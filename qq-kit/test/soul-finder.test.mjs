import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findSoulFile, describeSoulLocations, CANDIDATES } from '../src/soul-finder.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'soul-'));

test('findSoulFile：显式路径优先', () => {
  const dir = tmp();
  const file = path.join(dir, 'my-soul.md');
  fs.writeFileSync(file, '# 我的人格');
  const found = findSoulFile({ explicit: file, roots: [dir] });
  assert.equal(found.path, file);
  assert.equal(found.source, 'config');
});

test('findSoulFile：留空时自动在约定位置找', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'soul.md'), '# 根目录的灵魂');
  const found = findSoulFile({ explicit: '', roots: [dir] });
  assert.ok(found, '应该找到');
  assert.equal(path.basename(found.path), 'soul.md');
});

test('findSoulFile：推荐位置 persona/soul.md 也能找到', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'persona'));
  fs.writeFileSync(path.join(dir, 'persona', 'soul.md'), '# 人格');
  const found = findSoulFile({ explicit: '', roots: [dir] });
  assert.ok(found?.path.endsWith(path.join('persona', 'soul.md')), `实际: ${found?.path}`);
});

test('findSoulFile：explicit=false 表示坚决不要', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'soul.md'), '# 有文件也不要');
  assert.equal(findSoulFile({ explicit: false, roots: [dir] }), null);
});

test('findSoulFile：显式路径不存在时告警并回落自动查找', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'soul.md'), '# 回落到这个');
  const warns = [];
  const found = findSoulFile({
    explicit: path.join(dir, '不存在.md'),
    roots: [dir],
    warn: (m) => warns.push(m),
  });
  assert.ok(found, '应该回落到自动找到的');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /不存在/);
});

test('findSoulFile：什么都没有返回 null', () => {
  const dir = tmp();
  assert.equal(findSoulFile({ explicit: '', roots: [dir] }), null);
});

test('findSoulFile：多个根目录按顺序找，第一个找到的赢', () => {
  const a = tmp();
  const b = tmp();
  fs.writeFileSync(path.join(a, 'soul.md'), '# A');
  fs.writeFileSync(path.join(b, 'soul.md'), '# B');
  const found = findSoulFile({ explicit: '', roots: [a, b] });
  assert.equal(path.dirname(found.path), a, '应该用第一个根目录里的');
});

test('describeSoulLocations：给出可直接照做的路径', () => {
  const dir = tmp();
  const text = describeSoulLocations([dir]);
  assert.ok(text.includes(path.join(dir, 'soul.md')), '要给出完整路径');
  assert.ok(text.includes('persona'), '要提到推荐的 persona/ 目录');
});

test('CANDIDATES：清单非空且都指向 md 文件', () => {
  assert.ok(CANDIDATES.length > 0);
  for (const c of CANDIDATES) assert.match(c, /\.md$/i, `${c} 应该是 md`);
});
