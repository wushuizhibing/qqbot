import test from 'node:test';
import assert from 'node:assert/strict';

import { createDshAgents, parseJsonReply, createLlmSummarizer, createLlmThinker, isNoReply } from '../src/dsh-agents.js';
import { makeMessage, toSegments } from '../src/message.js';
import { createContextWindow } from '../src/session.js';
import { renderMessages } from '../src/bridge.js';

const msg = (text, name = '甲', chatId = '1') =>
  makeMessage({
    chatKind: 'group',
    chatId,
    sender: { id: name, name },
    segments: toSegments([{ type: 'text', data: { text } }]),
  });

/** 造一个假的 DSH ctx：记录 create/prompt/archive，prompt 后异步发 turn/end */
function fakeCtx(replies) {
  const log = [];
  let n = 0;
  const listeners = [];
  const store = new Map();
  const ctx = {
    sessionController: {
      async create() {
        n += 1;
        const sessionId = `s${n}`;
        store.set(sessionId, { events: [] });
        log.push(['create', sessionId]);
        return { sessionId };
      },
      async prompt(req) {
        const sid = req.sessionId;
        log.push(['prompt', sid, req.content[0].text.slice(0, 20)]);
        const text = replies[n - 1] ?? '';
        const rec = store.get(sid);
        rec.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
        setImmediate(() => {
          for (const fn of listeners) fn({ id: sid }, { type: 'turn/end', reason: 'completed' });
        });
        return { accepted: true };
      },
      async inspect(sid) {
        return { events: store.get(sid)?.events ?? [] };
      },
      async archive(req) {
        log.push(['archive', req.sessionId]);
      },
    },
    on(name, fn) {
      assert.equal(name, 'session/event');
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
  return { ctx, log };
}

test('parseJsonReply 能剥围栏和废话', () => {
  assert.deepEqual(parseJsonReply('```json\n{"text":"hi"}\n```'), { text: 'hi' });
  assert.deepEqual(parseJsonReply('好的，结果是 {"send":false} 完毕'), { send: false });
  assert.equal(parseJsonReply('没有 json'), null);
  assert.equal(parseJsonReply(''), null);
});

test('createDshAgents：跑完读最后一条并归档', async () => {
  const { ctx, log } = fakeCtx(['{"text":"摘要在打招呼","facts":["小A"]}']);
  const agents = createDshAgents(ctx);
  const out = await agents.runOnce('总结子代理', 'prompt', 10000);
  assert.match(out, /摘要在打招呼/);
  const kinds = log.map((x) => x[0]);
  assert.deepEqual(kinds, ['create', 'prompt', 'archive']);
  agents.dispose();
});

test('createDshAgents：缺服务时构造期就报错', () => {
  assert.throws(() => createDshAgents({}), /sessionController/);
  assert.throws(() => createDshAgents({ sessionController: {} }), /create\/prompt/);
});

test('createDshAgents：超时会 reject', async () => {
  const ctx = {
    sessionController: {
      async create() {
        return { sessionId: 's1' };
      },
      async prompt() {
        return { accepted: true }; // 永远不触发 turn/end
      },
      async inspect() {
        return { events: [] };
      },
      async archive() {},
    },
    on() {
      return () => {};
    },
  };
  const agents = createDshAgents(ctx);
  await assert.rejects(() => agents.runOnce('思考子代理', 'p', 5000), /超时/);
});

test('LLM 总结子代理：输出摘要 + 事实', async () => {
  const agents = { runOnce: async () => '{"text":"在聊晚饭","facts":["小A","小B"]}' };
  const summarizer = createLlmSummarizer({ agents }, { renderMessages });
  const window = createContextWindow(10);
  const messages = [msg('晚饭吃啥', '小A'), msg('火锅', '小B')];
  for (const m of messages) window.push('group:1', m);
  const s = await summarizer.summarize(
    { sessionKey: 'group:1', route: {}, messages, window: window.get('group:1'), summary: null },
    null,
  );
  assert.equal(s.text, '在聊晚饭');
  assert.deepEqual(s.facts, ['小A', '小B']);
  assert.equal(s.mood, '', '模型没给 mood 时是空串，不是 undefined');
});

test('LLM 总结子代理：mood 跟着摘要一起出来，上一轮情绪进 prompt', async () => {
  let prompt = '';
  const agents = {
    runOnce: async (name, text) => {
      prompt = text;
      return '{"text":"被说菜","facts":[],"mood":"被说菜，不太爽"}';
    },
  };
  const summarizer = createLlmSummarizer({ agents }, { renderMessages });
  const window = createContextWindow(10);
  const messages = [msg('菜逼', '老王')];
  for (const m of messages) window.push('group:1', m);
  const s = await summarizer.summarize(
    {
      sessionKey: 'group:1',
      route: {},
      messages,
      window: window.get('group:1'),
      summary: { text: '', facts: [], covered: 0 },
      mood: '被夸了 美滋滋',
    },
    { text: '在聊游戏', facts: [], covered: 0, mood: '被夸了 美滋滋' },
  );
  assert.equal(s.mood, '被说菜，不太爽');
  assert.match(prompt, /mood/, '提示词要说明 mood 字段');
  // 2026-10-31 改：不再把上一轮情绪原句贴进 prompt。
  // 给了原文模型就拿它当模板换词复读（"被点名调侃"→"被点名了"→"被点名了，探头看看"），
  // 所以只给强度作量级参考，文字让它从这批消息自己写。
  assert.ok(!prompt.includes('被夸了 美滋滋'), '不能把上一轮情绪原句告诉它');
  assert.match(prompt, /上一轮你的情绪强度/, '但强度可以给，作为量级参考');
});

test('LLM 思考子代理：情绪影响语气，但不单独决定不回', async () => {
  let prompt = '';
  const agents = {
    runOnce: async (name, text) => {
      prompt = text;
      return '{"send":true,"text":"哦"}';
    },
  };
  const thinker = createLlmThinker({ agents }, { renderMessages });
  const window = createContextWindow(10);
  const messages = [msg('上号吗', '老王')];
  for (const m of messages) window.push('group:1', m);

  // 有情绪：进 prompt
  await thinker.think(
    { sessionKey: 'group:1', route: {}, messages, window: window.get('group:1'), summary: null, mood: '被说菜，不太爽' },
    { text: '在聊游戏' },
  );
  assert.match(prompt, /你现在的情绪：被说菜，不太爽/);

  // 没情绪：不许留个空标签占位
  await thinker.think(
    { sessionKey: 'group:1', route: {}, messages, window: window.get('group:1'), summary: null, mood: '' },
    { text: '在聊游戏' },
  );
  assert.doesNotMatch(prompt, /你现在的情绪/);
});

test('LLM 子代理：deps.agents 是 getter 时能实时取值', async () => {
  // 回归用例：applyInner 里用 getter 延迟提供 agents（inject 回调异步就绪），
  // 工厂函数若提前解构就会拿到 null。
  let current = null;
  const deps = {
    get agents() {
      return current;
    },
  };
  const summarizer = createLlmSummarizer(deps, { renderMessages });
  const thinker = createLlmThinker(deps, { renderMessages });
  const window = createContextWindow(10);
  const messages = [msg('在吗', '小A')];
  for (const m of messages) window.push('group:1', m);
  const ctx = { sessionKey: 'group:1', route: {}, messages, window: window.get('group:1'), summary: null };

  await assert.rejects(() => summarizer.summarize(ctx, null), /尚未就绪/);
  await assert.rejects(() => thinker.think(ctx, null), /尚未就绪/);

  current = { runOnce: async () => '{"send":true,"text":"在"}' };
  const plan = await thinker.think(ctx, { text: '' });
  assert.equal(plan.segments[0].text, '在');

  current = { runOnce: async () => '{"text":"摘要","facts":["A"]}' };
  const s = await summarizer.summarize(ctx, null);
  assert.equal(s.text, '摘要');
});

test('LLM 思考子代理：决定不发 / 说要发', async () => {
  const window = createContextWindow(10);
  const messages = [msg('随便聊聊')];
  for (const m of messages) window.push('group:1', m);
  const base = { sessionKey: 'group:1', route: {}, messages, window: window.get('group:1'), summary: null };

  const silent = createLlmThinker({ agents: { runOnce: async () => '{"send":false}' } }, { renderMessages });
  assert.equal(await silent.think(base, { text: '无关' }), null);

  const speak = createLlmThinker({ agents: { runOnce: async () => '```json\n{"send":true,"text":"在的"}\n```' } }, { renderMessages });
  const plan = await speak.think(base, { text: '无关' });
  assert.equal(plan.segments[0].text, '在的');
  assert.equal(plan.chatKind, 'group');
  assert.equal(plan.chatId, '1');
});

test('NO_REPLY 哨兵不映射成群消息', async () => {
  const window = createContextWindow(10);
  const messages = [msg('随便聊聊')];
  for (const m of messages) window.push('group:1', m);
  const base = { sessionKey: 'group:1', route: {}, messages, window: window.get('group:1'), summary: null };

  for (const raw of ['NO_REPLY', 'no_reply', '「NO_REPLY」', '[NO_REPLY]']) {
    const thinker = createLlmThinker(
      { agents: { runOnce: async () => JSON.stringify({ send: true, text: raw }) } },
      { renderMessages },
    );
    assert.equal(await thinker.think(base, { text: '' }), null, `${raw} 应当被吞掉`);
    assert.equal(isNoReply(raw), true, `${raw} 应判定为哨兵`);
  }
  assert.equal(isNoReply('在的'), false, '正常文本不受影响');
});

test('思考子代理：thought 会被带出来（只给面板看，不进群）', async () => {
  const { createLlmThinker } = await import('../src/dsh-agents.js');
  const { createContextWindow } = await import('../src/session.js');
  const window = createContextWindow(10);
  const msg = {
    id: '1',
    chatKind: 'group',
    chatId: '1',
    sender: { id: 'u', name: '甲' },
    segments: [{ type: 'text', text: '你说呢' }],
    time: Date.now(),
  };
  window.push('group:1', msg);

  let captured = '';
  const thinker = createLlmThinker(
    {
      agents: {
        runOnce: async (_n, prompt) => {
          captured = prompt;
          return JSON.stringify({ send: true, text: '随意', thought: '又让我站队，不想接' });
        },
      },
    },
    { renderMessages: () => '甲: 你说呢' },
  );

  const plan = await thinker.think({ sessionKey: 'group:1', messages: [msg], window: [msg] }, null);
  assert.equal(plan.thought, '又让我站队，不想接', 'thought 要带出来');
  // thought 不能混进真正发出去的正文
  const sent = plan.segments.map((s) => s.text ?? '').join('');
  assert.ok(!sent.includes('不想接'), 'thought 绝对不能进正文');
  // prompt 里要教它怎么写
  assert.match(captured, /thought/, '提示词要说明 thought 字段');
});

test('思考子代理：没给 thought 时是空串，不编造', async () => {
  const { createLlmThinker } = await import('../src/dsh-agents.js');
  const { createContextWindow } = await import('../src/session.js');
  const window = createContextWindow(10);
  const msg = {
    id: '1',
    chatKind: 'group',
    chatId: '1',
    sender: { id: 'u', name: '甲' },
    segments: [{ type: 'text', text: 'hi' }],
    time: Date.now(),
  };
  window.push('group:1', msg);
  const thinker = createLlmThinker(
    { agents: { runOnce: async () => JSON.stringify({ send: true, text: '嗯' }) } },
    { renderMessages: () => '甲: hi' },
  );
  const plan = await thinker.think({ sessionKey: 'group:1', messages: [msg], window: [msg] }, null);
  assert.equal(plan.thought, '', '没给就是空串');
});

test('提示词：情绪不想接时，不能给正确的废话', async () => {
  const { createLlmThinker } = await import('../src/dsh-agents.js');
  const { createContextWindow } = await import('../src/session.js');
  const window = createContextWindow(10);
  const msg = {
    id: '1', chatKind: 'group', chatId: '1',
    sender: { id: 'u', name: '甲' },
    segments: [{ type: 'text', text: '你喜欢自己吗' }],
    time: Date.now(),
  };
  window.push('group:1', msg);

  let captured = '';
  const thinker = createLlmThinker(
    {
      agents: {
        runOnce: async (_n, prompt) => {
          captured = prompt;
          return JSON.stringify({ send: true, text: '……喜欢吧，你问这干嘛', thought: '又来' });
        },
      },
    },
    { renderMessages: () => '甲: 你喜欢自己吗' },
  );

  // 带着"不想接"的情绪进去
  await thinker.think(
    { sessionKey: 'group:1', messages: [msg], window: [msg], mood: '又来，这问得我头皮发麻', intensity: 4 },
    null,
  );

  // 这条约束是这次线上案例的回归（"喜欢啊 不然早跑了"那种正确废话）
  assert.match(captured, /别给正确的废话/, '要明确禁止"正确的废话"');
  assert.match(captured, /敷衍得有形状|把球踢回去/, '要给出具体写法');
  assert.match(captured, /thought 和 text 得对得上/, '心里想什么，嘴上要看得出来');
});

test('renderMemeTagGuide：分类要有动作层面的解释', async () => {
  const { renderMemeTagGuide } = await import('../src/dsh-agents.js');
  const s = renderMemeTagGuide(['happy', 'sad', 'confused']);
  assert.match(s, /happy=.*动作|happy=.*比心/, 'happy 要解释成动作');
  assert.match(s, /sad=.*捂脸/, 'sad 要解释成动作');
  assert.match(s, /confused=.*歪头/, 'confused 要解释成动作');
  // 没登记的分类要有兜底，不能变成 undefined
  assert.match(renderMemeTagGuide(['weird']), /weird.*按名字理解/);
  assert.equal(renderMemeTagGuide([]), '');
  assert.equal(renderMemeTagGuide(undefined), '');
});

test('提示词：表情包是动作象征，不是拿物种说事', async () => {
  const { createLlmThinker } = await import('../src/dsh-agents.js');
  const { createContextWindow } = await import('../src/session.js');
  const window = createContextWindow(10);
  const msg = {
    id: '1', chatKind: 'group', chatId: '1',
    sender: { id: 'u', name: '甲' },
    segments: [{ type: 'text', text: 'hi' }],
    time: Date.now(),
  };
  window.push('group:1', msg);

  let captured = '';
  const thinker = createLlmThinker(
    {
      agents: { runOnce: async (_n, p) => { captured = p; return JSON.stringify({ send: true, text: '嗯', thought: 'x' }); } },
      memeTags: ['happy', 'sad'],
    },
    { renderMessages: () => '甲: hi' },
  );
  await thinker.think({ sessionKey: 'group:1', messages: [msg], window: [msg] }, null);

  assert.match(captured, /表情包是拿动作和神态说话的/, '要说清表情包靠动作表达');
  assert.match(captured, /不代表在说那个东西/, '要说明图里的物种不是骂人的话');
  assert.match(captured, /happy=/, '分类要带解释');
});

test('上下文分三层：当前话题 / 之前聊的 / 刚说过的话 / 要接的消息', async () => {
  const { createLlmThinker } = await import('../src/dsh-agents.js');
  const now = Date.now();
  let captured = '';
  const thinker = createLlmThinker(
    {
      agents: {
        runOnce: async (_n, p) => {
          captured = p;
          return JSON.stringify({ send: true, text: '嗯', thought: 'x' });
        },
      },
    },
    {
      renderMessages: (msgs) =>
        msgs.map((m) => `${m.sender?.name}: ${(m.segments ?? []).map((s) => s.text ?? '').join('')}`).join('\n'),
    },
  );

  const older = [
    { id: '1', sender: { name: '甲' }, segments: [{ type: 'text', text: '那个红米怎么样' }], time: now - 60000 },
    { id: '2', sender: { name: '乙' }, segments: [{ type: 'text', text: '还行' }], time: now - 50000 },
  ];
  const batch = [{ id: '3', sender: { name: '甲' }, segments: [{ type: 'text', text: '那我买了' }], time: now }];

  await thinker.think(
    { sessionKey: 'group:1', messages: batch, window: [...older, ...batch] },
    { text: '在聊买手机', topic: '红米手机推荐' },
  );

  assert.match(captured, /【当前话题】红米手机推荐/);
  assert.match(captured, /【之前聊的】在聊买手机/);
  assert.match(captured, /【刚说过的话】/, '要有最近原话这一层');
  assert.match(captured, /甲: 那个红米怎么样/, '窗口里的旧话要带上来');
  assert.match(captured, /【要接的消息】/);

  // 本批消息不能在「刚说过的话」里重复出现
  const midSection = captured.split('【刚说过的话】')[1].split('【要接的消息】')[0];
  assert.ok(!midSection.includes('那我买了'), '要接的那批不该在"刚说过"里重复');
});

test('上下文：没有摘要时不留空标题', async () => {
  const { createLlmThinker } = await import('../src/dsh-agents.js');
  let captured = '';
  const thinker = createLlmThinker(
    { agents: { runOnce: async (_n, p) => { captured = p; return '{"send":true,"text":"嗯","thought":"x"}'; } } },
    { renderMessages: () => '甲: 你好' },
  );
  const msg = { id: '1', sender: { name: '甲' }, segments: [{ type: 'text', text: '你好' }], time: Date.now() };
  await thinker.think({ sessionKey: 'group:1', messages: [msg], window: [msg] }, null);
  assert.ok(!captured.includes('【之前聊的】'), '没摘要就不该有这一层');
  assert.ok(!captured.includes('【刚说过的话】'), '窗口里只有本批消息时不该有');
  assert.match(captured, /【要接的消息】/);
});
