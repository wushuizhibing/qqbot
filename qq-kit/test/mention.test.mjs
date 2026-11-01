import test from 'node:test';
import assert from 'node:assert/strict';

import { isMention, makeMessage, toSegments } from '../src/message.js';
import { createMerger } from '../src/merge.js';

const atMsg = (id, chatId = '1') =>
  makeMessage({
    chatKind: 'group',
    chatId,
    sender: { id: '999', name: '路人' },
    segments: toSegments([{ type: 'at', data: { qq: id } }, { type: 'text', data: { text: ' 在吗' } }]),
  });

const plainMsg = (chatId = '1') =>
  makeMessage({
    chatKind: 'group',
    chatId,
    sender: { id: '999', name: '路人' },
    segments: toSegments([{ type: 'text', data: { text: '随便说说' } }]),
  });

test('isMention：认出 @我', () => {
  assert.equal(isMention(atMsg('100000001'), { selfId: '100000001' }), true);
  assert.equal(isMention(atMsg('100000001'), { selfId: '123' }), false, '不是我的号不算');
  assert.equal(isMention(plainMsg(), { selfId: '100000001' }), false);
});

test('isMention：@全体成员 也算在叫', () => {
  assert.equal(isMention(atMsg('all'), { selfId: '100000001' }), true);
});

test('isMention：没配 selfId 时只有 @全体 算', () => {
  assert.equal(isMention(atMsg('100000001'), {}), false);
  assert.equal(isMention(atMsg('all'), {}), true);
});

test('合并器：被 @ 的消息绕过限流立刻触发', () => {
  const fired = [];
  const merger = createMerger({
    windowMs: 200,
    perMinute: 1,
    maxMessages: 99,
    isUrgent: (m) => isMention(m, { selfId: '100000001' }),
  });
  merger.setHandler((key, items) => fired.push(items.map((m) => m.id)));

  // 先用掉这分钟唯一的额度
  merger.push(plainMsg());
  merger.flush('group:1');
  assert.equal(fired.length, 1);

  // 再来的普通消息会被限流，但 @ 必须立刻过
  const urgent = atMsg('100000001');
  merger.push(urgent);
  assert.equal(fired.length, 2, '@ 消息不该被限流压住');
  assert.deepEqual(fired[1], [urgent.id]);
  merger.close();
});

test('合并器：没配 isUrgent 时行为不变', () => {
  const fired = [];
  const merger = createMerger({ windowMs: 30, perMinute: 0 });
  merger.setHandler((key, items) => fired.push(items.length));
  merger.push(plainMsg());
  merger.push(atMsg('100000001'));
  assert.equal(fired.length, 0, '还要等窗口');
  merger.close();
});

test('合并器：perMinute 小数退化成固定间隔（走普通窗口路径）', async () => {
  const fired = [];
  // windowMs 很小，让窗口尽快到点；0.5/分钟 = 120 秒间隔
  const merger = createMerger({ windowMs: 20, perMinute: 0.5, maxMessages: 99 });
  merger.setHandler((key, items) => fired.push(items.length));

  // 第一次：没历史，窗口到点就放行
  merger.push(plainMsg());
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fired.length, 1, '第一次应该放行');

  // 紧接着再来：间隔不够（120 秒），窗口到点也必须被拦
  merger.push(plainMsg());
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fired.length, 1, '间隔不够时不该触发');

  merger.close();
});

test('合并器：perMinute=0 表示不限', () => {
  const fired = [];
  const merger = createMerger({ windowMs: 20, perMinute: 0, maxMessages: 99 });
  merger.setHandler((key, items) => fired.push(items.length));
  for (let i = 0; i < 5; i += 1) merger.flush('group:1');
  merger.push(plainMsg());
  merger.flush('group:1');
  assert.ok(fired.length >= 1);
  merger.close();
});
