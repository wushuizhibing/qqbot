import test from 'node:test';
import assert from 'node:assert/strict';
import { fromOneBot, toOneBotSegments, toOneBotId } from '../adapters/onebot.js';
import { toPlainText } from '../src/message.js';

test('OneBot 群消息 -> 内部消息', () => {
  const m = fromOneBot({
    post_type: 'message',
    message_type: 'group',
    group_id: 200000001,
    user_id: 2339271820,
    message_id: 1806739136,
    time: 1792665000,
    sender: { card: 'mwei', nickname: 'M' },
    message: [{ type: 'text', data: { text: 'hello' } }],
  });
  assert.equal(m.chatKind, 'group');
  assert.equal(m.chatId, '200000001');
  assert.equal(m.sender.name, 'mwei');
  assert.equal(m.id, '1806739136');
  assert.equal(m.time, 1792665000000);
  assert.equal(toPlainText(m.segments), 'hello');
});

test('OneBot 私聊消息用 user_id 作为 chatId', () => {
  const m = fromOneBot({
    post_type: 'message',
    message_type: 'private',
    user_id: 100000001,
    message_id: 1,
    message: [{ type: 'text', data: { text: 'hi' } }],
    sender: {},
  });
  assert.equal(m.chatKind, 'private');
  assert.equal(m.chatId, '100000001');
});

test('内部段 -> OneBot 段', () => {
  const segs = toOneBotSegments([
    { type: 'text', text: '在吗' },
    { type: 'at', id: '100000001' },
    { type: 'image', url: 'http://x/i.png' },
    { type: 'reply', id: '42' },
    { type: 'unknown', raw: {} },
  ]);
  assert.deepEqual(segs[0], { type: 'text', data: { text: '在吗' } });
  assert.deepEqual(segs[1], { type: 'at', data: { qq: '100000001' } });
  assert.deepEqual(segs[2], { type: 'image', data: { file: 'http://x/i.png' } });
  assert.deepEqual(segs[3], { type: 'reply', data: { id: '42' } });
  assert.equal(segs.length, 4, 'unknown 段丢掉');
});

test('ID 转数字，非法值原样保留', () => {
  assert.equal(toOneBotId('200000001'), 200000001);
  assert.equal(toOneBotId('abc'), 'abc');
});
