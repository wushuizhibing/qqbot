import test from 'node:test';
import assert from 'node:assert/strict';

import { carryMood, shorten, CARRY_RATIO } from '../src/emotion.js';
import {
  normalizeMood,
  MOOD_MAX,
  createTwoStageBridge,
  normalizeIntensity,
  amplifyIntensity,
  intensityLabel,
  agedIntensity,
  MOOD_INTENSITY_MAX,
} from '../src/bridge.js';
import { createContextWindow } from '../src/session.js';
import { makeMessage, toSegments } from '../src/message.js';
import { createLlmSummarizer } from '../src/dsh-agents.js';
import { renderMessages } from '../src/bridge.js';

const msg = (text, name = '甲', chatId = '1') =>
  makeMessage({
    chatKind: 'group',
    chatId,
    sender: { id: name, name },
    segments: toSegments([{ type: 'text', data: { text } }]),
  });

test('normalizeMood：空白和"没有情绪"都当空', () => {
  for (const raw of ['', '   ', '无', '没有', '平静', 'none', 'N/A', '-', null, undefined, '「无」']) {
    assert.equal(normalizeMood(raw), '', `${String(raw)} 应视为没有情绪`);
  }
});

test('normalizeMood：压成单行、去引号、限长', () => {
  assert.equal(normalizeMood('「被老王怼了，有点不爽」'), '被老王怼了，有点不爽');
  assert.equal(normalizeMood('被怼了\n\n很不爽'), '被怼了 很不爽');
  const long = '被'.repeat(200);
  assert.equal(normalizeMood(long).length, MOOD_MAX);
});

test('carryMood：上一轮没情绪就原样', () => {
  // 没情绪时 intensity/since 也一并归零，避免残留上一个情绪的强度
  assert.deepEqual(carryMood({ text: 'a', mood: '' }, null), { text: 'a', mood: '', intensity: 0, since: 0, carried: 0 });
  assert.deepEqual(carryMood({ text: 'a' }, { mood: '' }), { text: 'a', mood: '', intensity: 0, since: 0, carried: 0 });
  assert.deepEqual(carryMood(null, null), { mood: '', intensity: 0, since: 0, carried: 0 });
});

test('carryMood：新情绪永远优先', () => {
  const out = carryMood({ mood: '被夸了 美滋滋' }, { mood: '刚被怼了很不爽' });
  assert.equal(out.mood, '被夸了 美滋滋');
});

test('carryMood：上一轮还热、这一轮说没影响 → 减半带过去', () => {
  const previous = { mood: '被老王连怼三句，有点不爽，不想理他' };
  const out = carryMood({ text: '在聊别的', mood: '' }, previous);
  assert.ok(out.mood.length > 0, '不能一下清零');
  // 2026-10-31：文字不再截短（截多了会变成'被点名→被点→被'这样的残句），只降强度
  assert.equal(out.mood, previous.mood, '文字保持完整，靠强度衰减表达变淡');
  assert.ok(out.intensity < 8, '强度要降');
  assert.equal(out.text, '在聊别的', '摘要别被改掉');
});

test('carryMood：沿用最多 MAX_CARRY_ROUNDS 轮，之后清空（防止一句话挂一天）', () => {
  let previous = { mood: '被老王连怼三句，有点不爽，不想理他', intensity: 8, carried: 0 };
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    const next = carryMood({ text: 'x', mood: '' }, previous);
    seen.push({ mood: next.mood, intensity: next.intensity, carried: next.carried });
    previous = next;
  }
  // 前两轮沿用并衰减，第三轮起清空
  assert.ok(seen[0].mood.length > 0, '第 1 轮沿用');
  assert.ok(seen[1].mood.length > 0, '第 2 轮沿用');
  assert.equal(seen[2].mood, '', `第 3 轮应清空，实际 ${seen[2].mood}`);
  assert.equal(seen[2].intensity, 0, '清空后强度归零');
  assert.equal(seen[3].mood, '', '之后保持空');
  // 沿用期间强度单调不增
  assert.ok(seen[1].intensity <= seen[0].intensity);
});

test('carryMood：新情绪来了就重置沿用计数', () => {
  const prev = { mood: '旧的', intensity: 4, carried: 2 };
  const out = carryMood({ text: 'x', mood: '有人喊开黑，来精神了', intensity: 6 }, prev);
  assert.equal(out.mood, '有人喊开黑，来精神了');
  assert.equal(out.carried, 0, '新情绪要重置沿用计数');
});

test('shorten：优先在标点处断开，不砍一半词', () => {
  assert.equal(shorten(''), '');
  assert.equal(shorten('短句'), '短句');
  const out = shorten('被老王怼了，有点不爽，不想理他');
  assert.ok(out.length < '被老王怼了，有点不爽，不想理他'.length);
  assert.ok(!out.endsWith('，'), '别留个尾巴标点');
  assert.equal(shorten('a'.repeat(20)).length, Math.ceil((20 * CARRY_RATIO) / 2));
});

test('桥接：上一轮的情绪会交到总结子代理和思考子代理手里', async () => {
  const window = createContextWindow(10);
  const got = {};
  const bridge = createTwoStageBridge({
    summarizer: {
      async summarize(ctx) {
        got.summarizePrev = ctx.mood;
        return { text: '在聊游戏', facts: [], covered: ctx.window.length, mood: '' };
      },
    },
    thinker: {
      async think(ctx) {
        got.thinkMood = ctx.mood;
        const last = ctx.messages.at(-1);
        return { chatKind: last.chatKind, chatId: last.chatId, segments: [{ type: 'text', text: '嗯' }], mode: 'reply' };
      },
    },
    window,
  });
  const messages = [msg('上号吗')];
  for (const m of messages) window.push('group:1', m);
  const { plan, mood } = await bridge.run({
    sessionKey: 'group:1',
    route: {},
    messages,
    window: window.get('group:1'),
    summary: { text: '刚被怼', facts: [], covered: 0, mood: '被怼了 有点烦' },
  });
  assert.equal(got.summarizePrev, '被怼了 有点烦', '总结子代理要看到上一轮情绪');
  assert.equal(got.thinkMood, '', '这一轮情绪是空的，就该空着');
  assert.equal(mood, '');
  assert.equal(plan.mode, 'reply');
});

test('桥接：总结刚给出情绪时，思考子代理立刻用上', async () => {
  const window = createContextWindow(10);
  let seen = null;
  const bridge = createTwoStageBridge({
    summarizer: {
      async summarize(ctx) {
        return { text: '被骂菜', facts: [], covered: ctx.window.length, mood: '「被说菜，不太爽」' };
      },
    },
    thinker: {
      async think(ctx) {
        seen = ctx.mood;
        const last = ctx.messages.at(-1);
        return { chatKind: last.chatKind, chatId: last.chatId, segments: [{ type: 'text', text: '哦' }], mode: 'reply' };
      },
    },
    window,
  });
  const messages = [msg('菜逼')];
  for (const m of messages) window.push('group:1', m);
  const { mood } = await bridge.run({
    sessionKey: 'group:1',
    route: {},
    messages,
    window: window.get('group:1'),
    summary: null,
  });
  assert.equal(seen, '被说菜，不太爽', '去掉引号后交给思考子代理');
  assert.equal(mood, '被说菜，不太爽');
});

test('normalizeIntensity：钳到 0-10 整数，脏数据归零', () => {
  assert.equal(normalizeIntensity(0), 0);
  assert.equal(normalizeIntensity(6), 6);
  assert.equal(normalizeIntensity(6.4), 6);
  assert.equal(normalizeIntensity(99), MOOD_INTENSITY_MAX);
  assert.equal(normalizeIntensity(-5), 0);
  assert.equal(normalizeIntensity('7'), 7);
  assert.equal(normalizeIntensity('abc'), 0);
  assert.equal(normalizeIntensity(null), 0);
});

test('intensityLabel：强度分档，0 是空串', () => {
  assert.equal(intensityLabel(0), '');
  assert.match(intensityLabel(2), /很淡/);
  assert.match(intensityLabel(4), /轻/);
  assert.match(intensityLabel(6), /明显/);
  assert.match(intensityLabel(8), /重/);
  assert.match(intensityLabel(10), /上头/);
});

test('agedIntensity：6 小时后减半，一天后基本散掉', () => {
  const now = 1_000_000_000_000;
  const sixHours = 6 * 60 * 60 * 1000;
  const oneDay = 24 * 60 * 60 * 1000;

  assert.equal(agedIntensity({ intensity: 8, since: now }, now), 8, '刚开始不衰减');
  assert.equal(agedIntensity({ intensity: 8, since: now }, now + sixHours), 4, '6 小时后减半');
  assert.ok(agedIntensity({ intensity: 8, since: now }, now + oneDay) <= 2, '一天后基本散掉');
});

test('agedIntensity：没有 since 时当新鲜，没强度时是 0', () => {
  assert.equal(agedIntensity({ intensity: 5 }), 5);
  assert.equal(agedIntensity({ intensity: 0, since: 1 }), 0);
  assert.equal(agedIntensity({}), 0);
});

test('carryMood：残留时强度也减半，since 保留原起点', () => {
  // 显式传 now：默认 Date.now() 会让 since 被时间窗判过期（这个测试只关心衰减，不关心时间窗）
  const since = 1_700_000_000_000;
  const now = since + 60 * 1000;
  const out = carryMood({ mood: '' }, { mood: '被老王连怼两句，有点不爽', intensity: 8, since }, now);
  assert.ok(out.mood.length > 0, '文字要带一半过来');
  assert.equal(out.intensity, 4, '强度砍一半');
  assert.equal(out.since, since, 'since 保留起点，让老化接着算');
});

test('桥接：强度会交给思考子代理', async () => {
  const window = createContextWindow(10);
  const msg = { id: '1', chatKind: 'group', chatId: '1', sender: { id: 'u', name: '甲' }, segments: [{ type: 'text', text: 'hi' }], time: Date.now() };
  window.push('group:1', msg);
  let seen = null;
  const bridge = createTwoStageBridge({
    summarizer: { summarize: async () => ({ text: 's', facts: [], covered: 1, mood: '有点烦', intensity: 7, since: Date.now() }) },
    thinker: {
      think: async (ctx) => {
        seen = ctx.intensity;
        return null;
      },
    },
    window,
  });
  await bridge.run({ sessionKey: 'group:1', route: {}, messages: [msg], window: [msg], summary: null });
  assert.ok(seen >= 7, '思考子代理要拿到放大后的强度（7 会变成 10）');
});

test('桥接：每轮都交给 summarizer（节流不在这层做）', async () => {
  const window = createContextWindow(10);
  const msg = { id: '1', chatKind: 'group', chatId: '1', sender: { id: 'u', name: '甲' }, segments: [{ type: 'text', text: 'hi' }], time: Date.now() };
  window.push('group:1', msg);
  let calls = 0;
  const bridge = createTwoStageBridge({
    summarizer: {
      summarize: async () => {
        calls += 1;
        return { text: '摘要', facts: [], covered: 1, mood: '有点烦', intensity: 5, since: Date.now() };
      },
    },
    thinker: { think: async () => null },
    window,
  });
  const ctx = { sessionKey: 'group:1', route: {}, messages: [msg], window: [msg], summary: null };
  await bridge.run(ctx);
  await bridge.run(ctx);
  await bridge.run(ctx);
  assert.equal(calls, 3, '桥接层每轮都调 summarizer，节流由 summarizer 自己决定');
});
test('桥接：多会话交错时，每个会话都按自己的轮次总结（不会卡死）', async () => {
  const window = createContextWindow(10);
  const msg = (chatId) => ({ id: '1', chatKind: 'group', chatId, sender: { id: 'u', name: '甲' }, segments: [{ type: 'text', text: 'hi' }], time: Date.now() });
  const calls = {};
  const bridge = createTwoStageBridge({
    summarizer: {
      summarize: async (c) => {
        const key = c.sessionKey;
        calls[key] = (calls[key] ?? 0) + 1;
        return { text: `${key}#${calls[key]}`, facts: [], covered: 1, mood: '有点烦', intensity: 3, since: Date.now() };
      },
    },
    thinker: { think: async () => null },
    window,
    summarizeEvery: 2,
  });

  const run = (key) => bridge.run({ sessionKey: key, route: {}, messages: [msg(key)], window: [msg(key)], summary: null });

  // 两个群交错跑：A B A B A B
  const a = { sessionKey: 'group:a' };
  const b = { sessionKey: 'group:b' };
  let lastA = null;
  let lastB = null;
  for (let i = 0; i < 3; i += 1) {
    lastA = await bridge.run({ ...a, route: {}, messages: [msg('a')], window: [msg('a')], summary: lastA?.summary ?? null });
    lastB = await bridge.run({ ...b, route: {}, messages: [msg('b')], window: [msg('b')], summary: lastB?.summary ?? null });
  }
  // 每个群各跑了 3 轮，every=2：第 2、3 轮该总结（第一轮没摘要也总结）
  // 关键断言：两个群都被总结过不止一次，没被"全局轮次取模"饿死
  assert.ok(calls['group:a'] >= 2, `A 应该总结多次，实际 ${calls['group:a']}`);
  assert.ok(calls['group:b'] >= 2, `B 应该总结多次，实际 ${calls['group:b']}`);
});

test('强度离散化：落在 0/2/4/6/8/10 这几档，不线性爬', async () => {
  const window = createContextWindow(10);
  const msg = { id: '1', chatKind: 'group', chatId: '1', sender: { id: 'u', name: '甲' }, segments: [{ type: 'text', text: 'hi' }], time: Date.now() };
  window.push('group:1', msg);

  // 模型给 1-10，看落点
  const results = [];
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const s = createLlmSummarizer(
      { agents: { runOnce: async () => JSON.stringify({ text: 't', mood: '有点烦', intensity: n }) } },
      { renderMessages },
    );
    const out = await s.summarize({ sessionKey: 'group:1', route: {}, messages: [msg], window: [msg], summary: null }, null);
    results.push(out.intensity);
  }
  // 每档都应该是偶数且不重复太多
  assert.ok(results.every((n) => n % 2 === 0), `应是偶数档，实际 ${results.join(',')}`);
  assert.ok(new Set(results).size <= 6, `档位不应太细，实际 ${results.join(',')}`);
});

test('模型说"无"时强度必须归零（不留上一轮余温）', async () => {
  const window = createContextWindow(10);
  const msg = { id: '1', chatKind: 'group', chatId: '1', sender: { id: 'u', name: '甲' }, segments: [{ type: 'text', text: 'hi' }], time: Date.now() };
  window.push('group:1', msg);
  const s = createLlmSummarizer(
    { agents: { runOnce: async () => JSON.stringify({ text: 't', mood: '无', intensity: 7 }) } },
    { renderMessages },
  );
  const out = await s.summarize(
    { sessionKey: 'group:1', route: {}, messages: [msg], window: [msg], summary: { text: 'p', mood: '上一轮很烦', intensity: 6 } },
    { text: 'p', mood: '上一轮很烦', intensity: 6 },
  );
  assert.equal(out.mood, '', 'mood 应该是空');
  assert.equal(out.intensity, 0, '强度必须归零，不能保留 7');
});

test('桥接返回的 intensity 是放大后的值（不是模型原始值）', async () => {
  const window = createContextWindow(10);
  const msg = { id: '1', chatKind: 'group', chatId: '1', sender: { id: 'u', name: '甲' }, segments: [{ type: 'text', text: 'hi' }], time: Date.now() };
  window.push('group:1', msg);
  const bridge = createTwoStageBridge({
    // 模型给原始强度 3
    summarizer: { summarize: async () => ({ text: 's', facts: [], covered: 1, mood: '有点烦', intensity: 3, since: Date.now() }) },
    thinker: { think: async () => null },
    window,
  });
  const out = await bridge.run({ sessionKey: 'group:1', route: {}, messages: [msg], window: [msg], summary: null });
  assert.ok(out.intensity > 3, `返回的应是放大后的强度，实际 ${out.intensity}`);
  assert.equal(out.summary.intensity, 3, '摘要里保留模型原始值，便于下一轮判断');
});

test('总结子代理：照抄上一轮的情绪会被拦掉（防止一句话挂一天）', async () => {
  const window = createContextWindow(10);
  const msg = { id: '1', chatKind: 'group', chatId: '1', sender: { id: 'u', name: '甲' }, segments: [{ type: 'text', text: 'hi' }], time: Date.now() };
  window.push('group:1', msg);
  const prev = { text: '旧摘要', mood: '又拿我编故事，气笑', intensity: 4, carried: 0 };

  // 模型原样抄回上一轮的情绪
  const copy = createLlmSummarizer(
    { agents: { runOnce: async () => JSON.stringify({ text: '新', mood: '又拿我编故事，气笑', intensity: 4 }) } },
    { renderMessages },
  );
  const out = await copy.summarize({ sessionKey: 'group:1', messages: [msg], window: [msg] }, prev);
  assert.equal(out.mood, '', '照抄要被拦成空，交给 carryMood 衰减');
  assert.equal(out.intensity, 0);

  // 换了措辞就该放行
  const fresh = createLlmSummarizer(
    { agents: { runOnce: async () => JSON.stringify({ text: '新', mood: '有人喊开黑，来精神了', intensity: 6 }) } },
    { renderMessages },
  );
  const out2 = await fresh.summarize({ sessionKey: 'group:1', messages: [msg], window: [msg] }, prev);
  assert.equal(out2.mood, '有人喊开黑，来精神了', '新情绪要正常保留');
});

test('effectiveIntensity：隔一天要真的散掉（不能被下限托住）', async () => {
  const { effectiveIntensity } = await import('../src/emotion.js');
  const now = 1_000_000_000_000;
  const h = 60 * 60 * 1000;
  assert.ok(effectiveIntensity({ intensity: 8, since: now }, now) >= 9, '新情绪要放大');
  const h6 = effectiveIntensity({ intensity: 8, since: now }, now + 6 * h);
  assert.ok(h6 > 0 && h6 <= 6, `6h 后该变淡，实际 ${h6}`);
  assert.equal(effectiveIntensity({ intensity: 8, since: now }, now + 24 * h), 0, '一天后要归零');
  assert.equal(effectiveIntensity({ intensity: 8, since: now }, now + 240 * h), 0, '十天后也必须 0');
});

test('mood-builtin：重启后能恢复各会话情绪', async () => {
  const { createBuiltinMood } = await import('../src/mood-builtin.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqkit-builtin-'));
  const file = path.join(dir, 'm.json');

  const a = createBuiltinMood({ moodFile: file }, () => {});
  a.observe({ sessionKey: 'group:X', mood: '被怼了，有点烦', intensity: 6 });
  a.save();

  const b = createBuiltinMood({ moodFile: file }, () => {});
  assert.ok(b.current('group:X').mood, '重启后别把情绪弄丢');
  assert.ok(b.current('group:X').intensity > 0, '强度也要回来');
  assert.equal(b.current('group:Y').mood, '', '没见过的会话是空的');
});

test('tooSimilar：能抓住"换个词再吐一遍"的复读', async () => {
  const { tooSimilar } = await import('../src/dsh-agents.js');

  // 同一句话改几个字 —— 该判为复读
  assert.equal(tooSimilar('被点名调侃，有点想回嘴', '被点名了，有点想回嘴'), true);
  assert.equal(tooSimilar('被人夸了，心里有点美。', '被人夸了，心里还挺美'), true);

  // 真不同的情绪 —— 不能误杀
  assert.equal(tooSimilar('被老王怼了', '有人喊开黑，来精神了'), false);
  assert.equal(tooSimilar('还是没人搭理我，懒得动', '被人接梗了，有点想笑'), false);
  assert.equal(tooSimilar('', '有点好奇'), false);
  assert.equal(tooSimilar('有点好奇', ''), false);
});

test('情绪 prompt 不再给模型看上一轮的原句', async () => {
  const { createLlmSummarizer } = await import('../src/dsh-agents.js');
  let captured = '';
  const sum = createLlmSummarizer(
    {
      agents: {
        runOnce: async (_name, prompt) => {
          captured = prompt;
          return JSON.stringify({ text: 'x', mood: '无', intensity: 0 });
        },
      },
    },
    { renderMessages: () => '消息内容' },
  );
  await sum.summarize(
    { sessionKey: 'g:1', messages: [], window: [] },
    { text: '旧摘要', mood: '被点名调侃，有点想回嘴', intensity: 6, since: Date.now() },
  );
  // 关键：原文不该出现在 prompt 里，否则模型会拿它当模板
  assert.ok(!captured.includes('被点名调侃，有点想回嘴'), '不能把上一轮情绪原句贴进 prompt');
  assert.ok(captured.includes('6/10'), '但强度可以给，作为量级参考');
});

test('carryMood：隔太久就不再沿用（光有轮数不够）', async () => {
  const { carryMood, CARRY_WINDOW_MS } = await import('../src/emotion.js');
  const now = 1_700_000_000_000;
  const min = 60 * 1000;

  const stale = carryMood(
    { text: '', mood: '' },
    { mood: '被点名怼了，有点不服。', intensity: 3, carried: 1, since: now - 20 * min },
    now,
  );
  assert.equal(stale.mood, '', '超过时间窗要清空');

  const fresh = carryMood(
    { text: '', mood: '' },
    { mood: '被点名怼了，有点不服。', intensity: 3, carried: 1, since: now - 2 * min },
    now,
  );
  assert.ok(fresh.mood, '窗口内继续沿用');

  assert.equal(CARRY_WINDOW_MS, 10 * 60 * 1000);
});

test('carryMood：情绪"挂半小时不变"的回归测试', async () => {
  const { carryMood } = await import('../src/emotion.js');
  const min = 60 * 1000;
  const t0 = 1_700_000_000_000;
  let s = carryMood({ text: '', mood: '被点名怼了，有点不服。', intensity: 6 }, null, t0);
  s = carryMood({ text: '', mood: '' }, s, t0 + 1 * min);
  s = carryMood({ text: '', mood: '' }, s, t0 + 3 * min);
  assert.equal(s.carried, 2);
  const later = carryMood({ text: '', mood: '' }, s, t0 + 18 * min);
  assert.equal(later.mood, '', '安静 15 分钟后旧情绪必须散掉');
});

test('情绪 prompt：要鼓励对有互动的消息产生反应，而不是一路写"无"', async () => {
  const { createLlmSummarizer } = await import('../src/dsh-agents.js');
  let captured = '';
  const sum = createLlmSummarizer(
    {
      agents: {
        runOnce: async (_n, prompt) => {
          captured = prompt;
          return JSON.stringify({ text: 'x', mood: '无', intensity: 0 });
        },
      },
    },
    { renderMessages: () => '消息' },
  );
  await sum.summarize({ sessionKey: 'g:1', messages: [], window: [] }, null);
  // 关键约束要在
  assert.match(captured, /别人直接跟你说话、点你名、接你的话时，要有反应/, '要鼓励对有互动的消息起反应');
  assert.match(captured, /intensity 1-2 也算数/, '淡情绪也算数，不是"没情绪"');
  // 但也不能走另一个极端：自我沉浸的写法仍然禁止
  assert.match(captured, /没人搭理我/, '自我沉浸还是禁止');
});
