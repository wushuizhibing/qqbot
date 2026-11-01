import test from 'node:test';
import assert from 'node:assert/strict';

import { makeMessage, toSegments, toPlainText, toOutboundSegments } from '../src/message.js';
import { createMerger } from '../src/merge.js';
import { sessionKeyOf, createRouter } from '../src/session.js';
import { MockAdapter } from '../adapters/mock.js';

test('toSegments 把协议段降级成内部段', () => {
  const segs = toSegments([
    { type: 'text', data: { text: 'hi' } },
    { type: 'at', data: { qq: '123', name: '小A' } },
    { type: 'image', data: { url: 'http://x/a.png' } },
    { type: 'weird-new-type', data: { foo: 1 } },
  ]);
  assert.deepEqual(segs[0], { type: 'text', text: 'hi' });
  assert.deepEqual(segs[1], { type: 'at', id: '123', name: '小A' });
  assert.equal(segs[2].type, 'image');
  assert.equal(segs[3].type, 'unknown');
  assert.equal(toPlainText(segs), 'hi@小A[图片]');
  assert.equal(toOutboundSegments(segs)[3].type, 'text');
});

test('makeMessage 补默认值', () => {
  const m = makeMessage({ chatKind: 'group', chatId: 1, sender: { id: '9' } });
  assert.equal(m.chatKind, 'group');
  assert.equal(m.chatId, '1');
  assert.ok(m.id.startsWith('local-'));
  assert.ok(m.time > 0);
});

test('合并器按窗口聚合，超量立刻 flush', async () => {
  const merger = createMerger({ windowMs: 30, maxMessages: 3, maxWaitMs: 200, perMinute: 0 });
  const got = [];
  merger.setHandler((key, items) => got.push([key, items.length]));
  const mk = (i) => makeMessage({ chatKind: 'group', chatId: '1', sender: { id: 'u' }, segments: [], id: `m${i}` });
  merger.push(mk(1));
  merger.push(mk(2));
  merger.push(mk(3)); // 到 maxMessages，立即 flush
  assert.deepEqual(got, [['group:1', 3]]);
  merger.push(mk(4));
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(got[1], ['group:1', 1]);
  merger.close();
});

test('限流：超出一分钟额度时推迟触发，消息不丢', async () => {
  // maxMessages 调大，避免"攒满"把限流绕过去
  const merger = createMerger({ windowMs: 20, maxMessages: 99, perMinute: 2, maxWaitMs: 200 });
  const got = [];
  merger.setHandler((key, items) => got.push(items.map((m) => m.id)));
  const mk = (i) => makeMessage({ chatKind: 'group', chatId: '9', sender: { id: 'u' }, segments: [], id: `m${i}` });

  merger.push(mk(1));
  await new Promise((r) => setTimeout(r, 40));
  merger.push(mk(2));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(got.length, 2, '额度内两次正常触发');

  merger.push(mk(3)); // 第三次超额度
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(got.length, 2, '超额度时推迟，不触发');

  // 正在攒的这批消息还在，下一次 push 会重新排窗口并在额度允许时发出
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(merger.pending(), 1, '被推迟的消息仍在队列里，没丢');
  merger.flush('group:9');
  assert.deepEqual(got[2], ['m3'], '下一次窗口正常发出，消息不丢');
  merger.close();
});

test('会话键区分群和私聊（单号，不带 selfId）', () => {
  const g = makeMessage({ chatKind: 'group', chatId: '111', sender: { id: '1' } });
  const p = makeMessage({ chatKind: 'private', chatId: '111', sender: { id: '1' } });
  assert.equal(sessionKeyOf(g), 'group:111');
  assert.equal(sessionKeyOf(p), 'private:111');
});

test('路由只命中启用的规则', () => {
  const r = createRouter([
    { chatKind: 'group', chatId: '1', workspacePath: '/a' },
    { chatKind: 'group', chatId: '2', enabled: false },
  ]);
  const m1 = makeMessage({ chatKind: 'group', chatId: '1', sender: { id: 'u' } });
  const m2 = makeMessage({ chatKind: 'group', chatId: '2', sender: { id: 'u' } });
  assert.equal(r.resolve(m1).workspacePath, '/a');
  assert.equal(r.resolve(m2), null);
});

test('mock 适配器能收能发', async () => {
  const a = new MockAdapter();
  const seen = [];
  a.setEvents({ onMessage: (m) => seen.push(m) });
  await a.start();
  a.receive({ chatId: '5', userId: '3', name: '甲', text: 'hi' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].chatId, '5');
  assert.equal(seen[0].sender.name, '甲');
  const r = await a.send({ chatKind: 'group', chatId: '5', segments: [{ type: 'text', text: 'ok' }] });
  assert.equal(a.sent.length, 1);
  assert.ok(r.messageId);
  await a.stop();
});
