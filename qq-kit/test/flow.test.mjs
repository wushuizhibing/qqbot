import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../index.js';
import { makeMessage, toSegments } from '../src/message.js';

function fakeCtx(config = {}) {
  const logs = [];
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      debug: (m) => logs.push(['debug', m]),
    },
    effect: () => {},
  };
  // 新签名：配置走 apply 的第二个参数，不是 ctx.config
  apply(ctx, { adapter: 'mock', merge: { windowMs: 20, perMinute: 0 }, useDshAgents: false, ...config });
  return { logs, ctx };
}

test('全量进窗口：没路由的消息也进窗口，不会被丢掉', () => {
  const { ctx } = fakeCtx({ coldSilenceMs: 60000 });
  const plugin = ctx.qqKit;
  const adapter = plugin.adapter;
  adapter.receive({ chatId: '999', userId: 'u1', name: '甲', text: '没路由也收' });
  assert.equal(plugin.window.get('group:999').length, 1);
});

test('冷场后第一条立刻触发（≤ 几个窗口内就该有结果）', async () => {
  const { ctx } = fakeCtx({ coldSilenceMs: 60000 });
  const plugin = ctx.qqKit;
  plugin.router.add({ chatKind: 'group', chatId: '777' });
  const adapter = plugin.adapter;

  adapter.receive({ chatId: '777', userId: 'u1', name: '甲', text: '第一句' });
  await new Promise((r) => setTimeout(r, 80));
  const first = adapter.sent.length;

  // 模拟过了很久：直接把 lastSeenAt 往回拨
  const key = 'group:777';
  plugin.__setLastSeen?.(key, Date.now() - 120000);
  adapter.receive({ chatId: '777', userId: 'u1', name: '甲', text: '很久之后' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(adapter.sent.length, first + 1, '冷场消息不等窗口');
});

test('全量推送下，一批里的每条消息都能被思考子代理看到', async () => {
  const { ctx } = fakeCtx({ coldSilenceMs: 60000 });
  const plugin = ctx.qqKit;
  plugin.router.add({ chatKind: 'group', chatId: '888' });
  const seen = [];
  let bridgePlan = null;
  // 记录思考子代理收到的消息数
  plugin.setAgents?.({
    summarizer: { async summarize(c) { return { text: '', facts: [], covered: c.window.length }; } },
    thinker: {
      async think(c) {
        seen.push(c.messages.map((m) => m.segments[0].text));
        const last = c.messages.at(-1);
        bridgePlan = last.chatId;
        return { chatKind: last.chatKind, chatId: last.chatId, segments: [{ type: 'text', text: 'ok' }], mode: 'reply' };
      },
    },
  });
  const adapter = plugin.adapter;
  adapter.send;
  adapter.receive({ chatId: '888', userId: 'u1', name: '甲', text: 'a' });
  adapter.receive({ chatId: '888', userId: 'u2', name: '乙', text: 'b' });
  adapter.receive({ chatId: '888', userId: 'u3', name: '丙', text: 'c' });
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(seen.length >= 1);
  const flat = seen.flat();
  assert.deepEqual(flat.sort(), ['a', 'b', 'c'], '一条不漏');
  assert.equal(bridgePlan, '888');
});
