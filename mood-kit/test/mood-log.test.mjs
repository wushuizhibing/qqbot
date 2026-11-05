import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMoodLog } from '../src/mood-log.js';

/** 造一个点 */
function pt(minutesAgo) {
  return {
    at: Date.now() - minutesAgo * 60000,
    sessionKey: 'group:1',
    mood: '开心',
    polarity: 0.5,
    intensity: 5,
  };
}

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moodlog-'));
  return path.join(dir, 'mood.json');
}

test('total：没到上限时等于现存条数', () => {
  const file = tmpFile();
  const log = createMoodLog({ file, max: 100, keepDays: 7 });
  log.push(pt(1));
  log.push(pt(2));
  assert.equal(log.size(), 2);
  assert.equal(log.total(), 2);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('total：超过上限后继续累加，不像 points.length 那样卡住', () => {
  // 真实问题：面板上的「情绪点」用 points.length，一到上限就永远显示 2000，
  // 看着像卡死了，其实是最早的在被丢掉。
  const file = tmpFile();
  const log = createMoodLog({ file, max: 5, keepDays: 7 });
  for (let i = 0; i < 12; i += 1) log.push(pt(i + 1));

  assert.equal(log.size(), 5, '现存最多 5 条');
  assert.equal(log.total(), 12, '累计应该是 12');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('total 落盘后能读回来', () => {
  const file = tmpFile();
  const log1 = createMoodLog({ file, max: 3, keepDays: 7 });
  for (let i = 0; i < 8; i += 1) log1.push(pt(i + 1));
  assert.equal(log1.total(), 8);

  // 重新打开，累计数不能丢
  const log2 = createMoodLog({ file, max: 3, keepDays: 7 });
  assert.equal(log2.size(), 3);
  assert.equal(log2.total(), 8, '重开之后累计还是 8');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('兼容老格式：文件是纯数组时也能读', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([pt(1), pt(2), pt(3)]), 'utf8');

  const log = createMoodLog({ file, max: 100, keepDays: 7 });
  assert.equal(log.size(), 3);
  assert.equal(log.total(), 3, '老数组的 total 就是长度');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('total 不会比现存条数少（数据写坏时的兜底）', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // total 故意写小
  fs.writeFileSync(file, JSON.stringify({ total: 1, points: [pt(1), pt(2), pt(3)] }), 'utf8');

  const log = createMoodLog({ file, max: 100, keepDays: 7 });
  assert.equal(log.total(), 3, '至少不能小于现存条数');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('按天数裁剪掉的也记进 total', () => {
  const file = tmpFile();
  const log = createMoodLog({ file, max: 100, keepDays: 1 });
  // 10 天前的点，应该被 keepDays 裁掉
  log.push(pt(10 * 24 * 60));
  log.push(pt(1));
  const kept = log.size();
  assert.ok(kept >= 1, '最近那条要留着');
  assert.ok(log.total() >= kept, 'total 至少等于留存的');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
