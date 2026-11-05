import test from 'node:test';
import assert from 'node:assert/strict';

import { makeMessage, toSegments } from '../src/message.js';
import { createContextWindow } from '../src/session.js';
import {
  createTwoStageBridge,
  createStubSummarizer,
  createStubThinker,
  validatePlan,
  renderMessages,
} from '../src/bridge.js';

const msg = (text, name = '甲', chatId = '1') =>
  makeMessage({
    chatKind: 'group',
    chatId,
    sender: { id: name, name },
    segments: toSegments([{ type: 'text', data: { text } }]),
  });

test('renderMessages 保留说话人和内容', () => {
  const text = renderMessages([msg('在吗', '小A')]);
  assert.match(text, /小A/);
  assert.match(text, /在吗/);
});

test('renderMessages 带上 QQ 号，供模型对记忆认人', () => {
  const m = makeMessage({
    chatKind: 'group',
    chatId: '1',
    sender: { id: '123456789', name: '06661' },
    segments: toSegments([{ type: 'text', data: { text: '哎' } }]),
    time: 1793248000000,
  });
  const text = renderMessages([m]);
  assert.match(text, /06661\(123456789\): 哎/, '格式必须是 名片(QQ号): 内容');
});

test('renderMessages 只有号码没名片时也不留空', () => {
  const m = makeMessage({
    chatKind: 'group',
    chatId: '1',
    sender: { id: '123' },
    segments: toSegments([{ type: 'text', data: { text: 'hi' } }]),
  });
  assert.match(renderMessages([m]), /123: hi/);
});

test('validatePlan：NO_REPLY 哨兵一律拦下', () => {
  for (const raw of ['NO_REPLY', 'no-reply', '「NO_REPLY」', ' [NO_REPLY] ']) {
    assert.equal(
      validatePlan({ chatKind: 'group', chatId: '1', segments: [{ type: 'text', text: raw }] }),
      null,
      `${raw} 不该成为消息`,
    );
  }
  // 混在正常话里不算哨兵，要正常发
  assert.ok(
    validatePlan({ chatKind: 'group', chatId: '1', segments: [{ type: 'text', text: '笑死 NO_REPLY' }] }),
  );
});

test('validatePlan 拦截脏计划', () => {
  assert.equal(validatePlan(null), null);
  assert.equal(validatePlan({ chatKind: 'weird', chatId: '1', segments: [] }), null);
  assert.equal(validatePlan({ chatKind: 'group', chatId: '1', segments: [] }), null);
  const ok = validatePlan({
    chatKind: 'group',
    chatId: '1',
    segments: [{ type: 'text', text: 'hi' }],
  });
  assert.equal(ok.mode, 'reply');
  assert.equal(
    validatePlan({
      chatKind: 'group',
      chatId: '1',
      segments: [{ type: 'text', text: 'hi' }],
      mode: 'quote',
      quoteId: 'm1',
    }).quoteId,
    'm1',
  );
  assert.equal(
    validatePlan({
      chatKind: 'group',
      chatId: '1',
      segments: [{ type: 'text', text: 'hi' }],
      mode: 'quote',
    }).quoteId,
    undefined,
  );
});

test('两段式桥接：先总结再思考，产出计划', async () => {
  const window = createContextWindow(10);
  const calls = [];
  const summarizer = {
    async summarize(ctx, prev) {
      calls.push('summarize');
      assert.equal(prev, null);
      return { text: '两人在打招呼', facts: ['小A'], covered: ctx.window.length };
    },
  };
  const thinker = {
    async think(ctx, summary) {
      calls.push('think');
      assert.equal(summary.text, '两人在打招呼');
      const last = ctx.messages.at(-1);
      return {
        chatKind: last.chatKind,
        chatId: last.chatId,
        segments: [{ type: 'text', text: '在的' }],
        mode: 'reply',
      };
    },
  };
  const bridge = createTwoStageBridge({ summarizer, thinker, window });
  const messages = [msg('在吗'), msg('人呢')];
  for (const m of messages) window.push('group:1', m);
  const { summary, plan } = await bridge.run({
    sessionKey: 'group:1',
    route: {},
    messages,
    window: window.get('group:1'),
    summary: null,
  });
  assert.deepEqual(calls, ['summarize', 'think']);
  assert.equal(summary.facts[0], '小A');
  assert.equal(plan.mode, 'reply');
});

test('占位子代理也能跑通链路', async () => {
  const window = createContextWindow(10);
  const bridge = createTwoStageBridge({
    summarizer: createStubSummarizer(),
    thinker: createStubThinker(),
    window,
  });
  const messages = [msg('你好')];
  for (const m of messages) window.push('group:1', m);
  const { summary, plan } = await bridge.run({
    sessionKey: 'group:1',
    route: {},
    messages,
    window: window.get('group:1'),
    summary: null,
  });
  assert.ok(summary.text.includes('1 条'));
  assert.deepEqual(plan.segments[0].text, '收到 1 条，最近一条来自 甲');
});

test('思考子代理可以决定不发', async () => {
  const window = createContextWindow(10);
  const bridge = createTwoStageBridge({
    summarizer: createStubSummarizer(),
    thinker: createStubThinker({ decide: async () => null }),
    window,
  });
  const messages = [msg('随便说说')];
  const { plan } = await bridge.run({
    sessionKey: 'group:1',
    route: {},
    messages,
    window,
    summary: null,
  });
  assert.equal(plan, null);
});

test('renderMessages：引用回复要带出被引的原话和说话人', () => {
  const t = 1793500000000;
  const msgs = [
    { id: '1', sender: { id: '1001', name: '鱼' }, segments: [{ type: 'text', text: '内存条给我留一条' }], time: t },
    {
      id: '2',
      sender: { id: '1002', name: 'Terey' },
      segments: [
        { type: 'reply', id: '1' },
        { type: 'at', id: '1001' },
        { type: 'text', text: ' 你知道规矩的' },
      ],
      time: t + 30000,
    },
  ];
  const out = renderMessages(msgs);
  // 以前只渲染成"[回复]"，模型看不出在接谁的哪句话 —— 于是答非所问
  assert.ok(!out.includes('[回复]'), '不该只剩一个 [回复] 标记');
  assert.match(out, /在回 .+ 的「内存条给我留一条」/, '要带出原话和被引的人');
  assert.match(out, /@鱼/, '@ 段要补上名字而不是光秃秃的 @');
});

test('renderMessages：引用目标在更宽窗口里也能还原', () => {
  const t = 1793500000000;
  const old = { id: '0', sender: { id: '9999', name: '老王' }, segments: [{ type: 'text', text: '谁有内存条' }], time: t - 5000 };
  const cur = {
    id: '2',
    sender: { id: '1002', name: 'Terey' },
    segments: [{ type: 'reply', id: '0' }, { type: 'text', text: '我有' }],
    time: t,
  };
  assert.match(renderMessages([cur], [old, cur]), /在回 老王 的「谁有内存条」/);
});

test('renderMessages：引用目标找不到时有兜底说明', () => {
  const cur = {
    id: '2',
    sender: { id: '1002', name: 'Terey' },
    segments: [{ type: 'reply', id: '999' }, { type: 'text', text: '嗯' }],
    time: Date.now(),
  };
  assert.match(renderMessages([cur]), /在回前面某条/);
});

test('renderMessages：图片要全局编号，能对上"哪张图配哪句话"', () => {
  const t = 1793500000000;
  const msgs = [
    { id: '1', sender: { id: '1001', name: '甲' }, segments: [{ type: 'text', text: '看这个' }, { type: 'image', url: 'x' }], time: t },
    { id: '2', sender: { id: '1002', name: '乙' }, segments: [{ type: 'image', url: 'y' }], time: t + 1000 },
    { id: '3', sender: { id: '1001', name: '甲' }, segments: [{ type: 'text', text: '哈哈' }, { type: 'image', url: 'z' }], time: t + 2000 },
  ];
  const out = renderMessages(msgs);
  // 跨消息连续编号，不是每条都从"图1"开始
  assert.match(out, /看这个\[图1\]/);
  assert.match(out, /乙\(1002\): \[图2\]/);
  assert.match(out, /哈哈\[图3\]/);
  assert.ok(!out.includes('[图片]'), '不该退回无编号的 [图片]');
});

test('validatePlan：thought 要保留（它是白名单重建，漏了就会被抹掉）', () => {
  const plan = {
    chatKind: 'group',
    chatId: '1',
    segments: [{ type: 'text', text: '嗯' }],
    mode: 'reply',
    thought: '这货又来钓我，懒得咬',
  };
  const v = validatePlan(plan);
  assert.ok(v, '计划要有效');
  assert.equal(v.thought, '这货又来钓我，懒得咬', 'thought 不能被丢掉');
});

test('validatePlan：没给 thought 时是空串，不会变成 undefined', () => {
  const v = validatePlan({
    chatKind: 'group',
    chatId: '1',
    segments: [{ type: 'text', text: '嗯' }],
  });
  assert.equal(v.thought, '', '统一成空串，面板好判断');
});

test('validatePlan：thought 超长要截断', () => {
  const v = validatePlan({
    chatKind: 'group',
    chatId: '1',
    segments: [{ type: 'text', text: '嗯' }],
    thought: 'x'.repeat(200),
  });
  assert.ok(v.thought.length <= 80, `实际 ${v.thought.length}`);
});

// ── @ 谁 ─────────────────────────────────────
//
// 协议端给 @ 段时通常只带 id 不带 name，而 nameOf 只从"这批 + 更宽窗口"里建。
// 之前查不到名字就只输出一个裸 `@`，模型看到「@ 什么默认？」根本不知道在问谁。

const atMsg = (id, sid, name, segs) => ({ id, time: Date.now(), sender: { id: sid, name }, segments: segs });

test('renderMessages：@ 人带上号，跟说话人格式一致', () => {
  const out = renderMessages([
    atMsg('1', '111', '老王', [{ type: 'text', text: '今天真累' }]),
    atMsg('2', '222', '小李', [{ type: 'at', id: '111' }, { type: 'text', text: ' 你怎么看' }]),
  ]);
  assert.match(out, /@老王\(111\)/, '应该渲染成 @名字(号)');
});

test('renderMessages：查不到名字的 @ 也要带号，不能只剩一个 @', () => {
  const out = renderMessages([atMsg('3', '333', '陌生人', [{ type: 'at', id: '999' }, { type: 'text', text: ' 在吗' }])]);
  assert.match(out, /@999/, '查不到名字就至少给号');
  assert.ok(!/\s@\s/.test(out), '不能出现光秃秃的 @');
});

test('renderMessages：@我 单独标出来', () => {
  const out = renderMessages([atMsg('4', '222', '小李', [{ type: 'at', id: '100000001' }, { type: 'text', text: ' 在吗' }])], [], {
    selfId: '100000001',
  });
  assert.match(out, /@我\(100000001\)/, '要能分出"这句是冲我来的"');
});

test('renderMessages：@全体成员 不被当成某个叫 all 的人', () => {
  const out = renderMessages([atMsg('5', '222', '小李', [{ type: 'at', id: 'all' }, { type: 'text', text: ' 开会' }])], [], {
    selfId: '100000001',
  });
  assert.match(out, /@全体成员/);
});

test('renderMessages：段里自带 name 时优先用它', () => {
  const out = renderMessages([atMsg('6', '222', '小李', [{ type: 'at', id: '111', name: '老王' }, { type: 'text', text: ' 好' }])]);
  assert.match(out, /@老王\(111\)/);
});
