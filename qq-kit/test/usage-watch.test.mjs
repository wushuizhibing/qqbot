import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUsageWatch } from '../src/usage-watch.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqkit-usage-'));
const ledger = (o) => {
  const f = path.join(tmp, `usage-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(o), 'utf8');
  return f;
};

test('没到阈值不提醒', async () => {
  const fired = [];
  const w = createUsageWatch({
    file: ledger({ date: '2026-10-29', todayUsage: 24.99 }),
    threshold: 25,
    onExceed: (i) => fired.push(i),
  });
  await w.tick();
  assert.equal(fired.length, 0);
});

test('到阈值提醒一次，同一天不重复', async () => {
  const fired = [];
  const file = ledger({ date: '2026-10-29', todayUsage: 25.3 });
  const w = createUsageWatch({
    file,
    threshold: 25,
    onExceed: (i) => fired.push(i),
  });
  await w.tick();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].today, 25.3);
  assert.equal(fired[0].threshold, 25);

  // 再扫一次：同一天不该再发
  await w.tick();
  assert.equal(fired.length, 1, '同一天只能提醒一次');

  // 换一天，重新计数
  fs.writeFileSync(file, JSON.stringify({ date: '2026-10-30', todayUsage: 30 }), 'utf8');
  await w.tick();
  assert.equal(fired.length, 2, '新的一天要重新提醒');
});

test('账本不存在时不报错、不提醒', async () => {
  const fired = [];
  const warnings = [];
  const w = createUsageWatch({
    file: path.join(tmp, 'nope.json'),
    threshold: 1,
    onExceed: () => fired.push(1),
    warn: (m) => warnings.push(m),
  });
  await w.tick();
  assert.equal(fired.length, 0);
  assert.equal(warnings.length, 0, '文件没生成属于正常，不该告警');
});

test('onExceed 抛错被吞掉，不影响后续扫描', async () => {
  const warnings = [];
  const w = createUsageWatch({
    file: ledger({ date: '2026-10-29', todayUsage: 99 }),
    threshold: 10,
    onExceed: () => {
      throw new Error('网络炸了');
    },
    warn: (m) => warnings.push(m),
  });
  await w.tick();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /用量提醒发送失败/);
});

test('threshold<=0 时不提醒（等于关闭）', async () => {
  const fired = [];
  const w = createUsageWatch({
    file: ledger({ date: '2026-10-29', todayUsage: 999 }),
    threshold: 0,
    onExceed: () => fired.push(1),
  });
  await w.tick();
  assert.equal(fired.length, 0);
});
