import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { snapshot, changedSince, WATCHED } from '../src/staleness.js';

/** 造一个临时插件目录 */
function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staleness-'));
  for (const rel of WATCHED) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '// v1\n');
  }
  return root;
}

test('staleness：没改动时返回空', () => {
  const root = mkRoot();
  const snap = snapshot(root);
  assert.deepEqual(changedSince(snap, root), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('staleness：改了文件就能查出来', () => {
  const root = mkRoot();
  const snap = snapshot(root);

  // 等一下再改，保证 mtime 变大（有些文件系统精度是秒）
  const p = path.join(root, 'src/panel.js');
  const old = fs.statSync(p).mtimeMs;
  fs.writeFileSync(p, '// v2\n');
  fs.utimesSync(p, new Date(old + 5000), new Date(old + 5000));

  const changed = changedSince(snap, root);
  assert.equal(changed.length, 1, '应该抓到 1 个文件');
  assert.equal(changed[0].file, 'src/panel.js');
  fs.rmSync(root, { recursive: true, force: true });
});

test('staleness：删掉的文件不算变更', () => {
  const root = mkRoot();
  const snap = snapshot(root);
  fs.rmSync(path.join(root, 'src/message.js'));
  const changed = changedSince(snap, root);
  assert.equal(changed.length, 0, '被删的文件不提示（可能是发布时排除的）');
  fs.rmSync(root, { recursive: true, force: true });
});

test('staleness：新出现的文件也算变更', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staleness2-'));
  // 只建一个，其余缺失（快照里记 0）
  fs.writeFileSync(path.join(root, 'index.js'), '// v1\n');
  const snap = snapshot(root);
  // 再补一个，mtime 从 0 变成具体值（先把目录建出来）
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/panel.js'), '// 新出现的\n');
  const changed = changedSince(snap, root);
  assert.ok(changed.some((x) => x.file === 'src/panel.js'), '新出现的文件要提示');
  fs.rmSync(root, { recursive: true, force: true });
});

test('staleness：WATCHED 覆盖关键模块', () => {
  for (const f of ['index.js', 'src/panel.js', 'src/state-observe.js', 'src/diary.js']) {
    assert.ok(WATCHED.includes(f), `${f} 应该在被监控列表里`);
  }
});
