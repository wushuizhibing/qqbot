import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../index.js';
import { isMention, makeMessage, toSegments } from '../src/message.js';

const atMsg = (id, name = '路人', senderId = '999') =>
  makeMessage({
    chatKind: 'group',
    chatId: '200000001',
    sender: { id: senderId, name },
    segments: toSegments([{ type: 'at', data: { qq: id } }, { type: 'text', data: { text: ' 来' } }]),
  });

function setup(config = {}) {
  const logs = [];
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      debug: () => {},
    },
    effect: () => {},
  };
  apply(ctx, {
    adapter: 'mock',
    useDshAgents: false,
    dryRun: false,
    merge: { windowMs: 10, perMinute: 0 },
    routes: [{ chatKind: 'group', chatId: '200000001' }],
    ...config,
  });
  return { api: ctx.qqKit, logs };
}

test('有人 @ 主人的号时，@ 出主人并发一句提醒（不走模型）', async () => {
  const { api, logs } = setup({
    notifyOnMention: { ids: ['123456789'], text: '有人点你', at: ['123456789'] },
  });
  const adapter = api.adapter;
  adapter.receive({ chatId: '200000001', userId: '999', name: '路人', text: '占位' });
  adapter.sent.length = 0;

  api.merger.push(atMsg('123456789'));
  await new Promise((r) => setTimeout(r, 80));

  assert.ok(adapter.sent.length >= 1, '必须发出提醒');
  const last = adapter.sent[adapter.sent.length - 1];
  assert.equal(last.segments[0].type, 'at', '必须先 @ 出主人');
  assert.equal(last.segments[0].id, '123456789');
  const text = last.segments.map((s) => s.text ?? '').join('');
  assert.match(text, /有人点你/);
  assert.ok(
    logs.some(([, m]) => m.includes('有人 @ 了被盯的号')),
    '日志里要能看到这是硬提醒',
  );
});

test('没配置 at 时退化成纯文本', async () => {
  const { api } = setup({ notifyOnMention: { ids: ['123456789'], text: '有人点你' } });
  const adapter = api.adapter;
  api.merger.push(atMsg('123456789'));
  await new Promise((r) => setTimeout(r, 80));
  const last = adapter.sent[adapter.sent.length - 1];
  assert.equal(last.segments.length, 1);
  assert.equal(last.segments[0].text, '有人点你');
});

test('@ 别的号不会触发硬提醒（走正常思考）', async () => {
  const { api } = setup({ notifyOnMention: { ids: ['123456789'], text: '有人点你' } });
  const adapter = api.adapter;
  adapter.receive({ chatId: '200000001', userId: '999', name: '路人', text: '占位' });
  adapter.sent.length = 0;

  api.merger.push(atMsg('1234567'));
  await new Promise((r) => setTimeout(r, 80));

  const texts = adapter.sent.map((s) => s.segments[0]?.text ?? '');
  assert.ok(!texts.includes('@你 有人点你'), '不该发提醒');
});

test('dryRun 时提醒也不真的发', async () => {
  const { api } = setup({ dryRun: true, notifyOnMention: { ids: ['123456789'], text: '有人点你' } });
  const adapter = api.adapter;
  api.merger.push(atMsg('123456789'));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(adapter.sent.length, 0, 'dryRun 下一条都不发');
});

test('被盯的号本身也会被当作紧急消息，绕过限流', () => {
  const merger = setup({ notifyOnMention: { ids: ['123456789'] } }).api.merger;
  assert.ok(merger);
  // 通过公开接口验证：push 之后应该立刻 flush（不用等窗口）
  const fired = [];
  merger.setHandler((key, items) => fired.push(items.length));
  merger.push(atMsg('123456789'));
  assert.equal(fired.length, 1, '被盯号的 @ 要立刻触发');
});
