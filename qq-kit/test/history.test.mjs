import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHistoryLog } from '../src/history.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqkit-hist-'));
const mkdir = () => path.join(tmp, `h-${Math.random().toString(16).slice(2)}`);

/** 读某天文件的全部行。 */
function readLines(dir, prefix = 'history') {
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.jsonl'));
  assert.equal(files.length, 1, `应该只有一个按天文件，实际 ${files.length}`);
  return fs
    .readFileSync(path.join(dir, files[0]), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('history：按天写 jsonl，一行一个事件', () => {
  const dir = mkdir();
  const log = createHistoryLog({ dir });
  log.write('recv', { key: 'group:1', text: '在吗' });
  log.write('sent', { key: 'group:1', text: '在' });
  log.close();

  const lines = readLines(dir);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, 'recv');
  assert.equal(lines[0].key, 'group:1');
  assert.equal(lines[1].type, 'sent');
  assert.ok(lines[0].t, '每行要带时间戳');
});

test('history：中文按 UTF-8 原样写回', () => {
  const dir = mkdir();
  const log = createHistoryLog({ dir });
  log.write('recv', { text: '这条鱼今天还活着吗🐟' });
  log.close();
  const lines = readLines(dir);
  assert.equal(lines[0].text, '这条鱼今天还活着吗🐟');
});

test('history：超过 keepDays 的旧文件会被清掉', () => {
  const dir = mkdir();
  fs.mkdirSync(dir, { recursive: true });
  // 造几个很旧的文件
  for (const d of ['2020-01-01', '2020-01-02', '2020-01-03']) {
    fs.writeFileSync(path.join(dir, `history-${d}.jsonl`), '{}\n', 'utf8');
  }
  const log = createHistoryLog({ dir, keepDays: 1 });
  log.write('recv', { text: 'x' });
  log.close();

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 1, '旧的都该被清掉，只留今天');
  assert.ok(!files[0].startsWith('history-2020'), '留下的必须是今天');
});

test('history：没配目录时是空实现，不报错', () => {
  const warnings = [];
  const log = createHistoryLog({ warn: (m) => warnings.push(m) });
  log.write('recv', { text: 'x' });
  log.close();
  assert.equal(warnings.length, 0);
  assert.equal(log.currentFile(), '');
});

test('history：目录不可写时告警但不抛', () => {
  const warnings = [];
  // 用一个必然创建失败的路径（Windows 下盘符非法）
  const log = createHistoryLog({ dir: 'Z:\\no\\such\\drive\\qq', warn: (m) => warnings.push(m) });
  log.write('recv', { text: 'x' });
  log.close();
  assert.ok(warnings.length >= 1, '应该告警');
});

test('history：单日超过上限就不再写', () => {
  const dir = mkdir();
  const log = createHistoryLog({ dir, maxBytesPerDay: 80 });
  for (let i = 0; i < 20; i += 1) log.write('recv', { text: 'x'.repeat(40) });
  log.close();
  const size = readLines(dir).length;
  assert.ok(size < 20, `超限后应该停写，实际写了 ${size} 行`);
  assert.ok(size > 0, '至少要写进去一条');
});

// ── 保留策略：别自动删数据 ──
//
// 2026-11-05：原来情绪点留 7 天 / 2000 条、历史日志留 30 天，
// 等于一个月前的记录自动消失。用户明确说过"不要让这些消失"。

test('history 日志：默认保留一年，不是 30 天', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createHistoryLog } = await import('../src/history.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-keep-'));
  // 造几个旧文件
  const old = ['2025-01-01', '2025-06-01', '2026-10-01'];
  for (const d of old) fs.writeFileSync(path.join(dir, `history-${d}.jsonl`), '{"type":"recv"}\n');

  // 不传 keepDays，用默认
  const log = createHistoryLog({ dir, prefix: 'history' });
  log.write('recv', { key: 'group:1', senderId: '1', senderName: 'a', text: 'hi', time: Date.now() });
  log.close?.();

  // 一年内的都该还在
  assert.ok(fs.existsSync(path.join(dir, 'history-2026-10-01.jsonl')), '一个月前的日志不该被删');
  fs.rmSync(dir, { recursive: true, force: true });
});
