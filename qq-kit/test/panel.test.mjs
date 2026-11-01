import test from 'node:test';
import assert from 'node:assert/strict';

import { collectState, renderPanelHtml, polarityOf, pushMoodPoint, MOOD_HISTORY_MAX } from '../src/panel.js';
import { makeMessage, toSegments } from '../src/message.js';
import { createContextWindow, createRouter } from '../src/session.js';

const msg = (text, name, chatId) =>
  makeMessage({
    chatKind: 'group',
    chatId,
    sender: { id: name, name },
    segments: toSegments([{ type: 'text', data: { text } }]),
    time: 1793248000000,
  });

test('collectState：列出路由会话和出现过的会话', () => {
  const window = createContextWindow(10);
  const router = createRouter([{ chatKind: 'group', chatId: '111' }]);
  const summaries = new Map([['group:111', { text: '在聊晚饭' }]]);
  const m1 = msg('吃啥', '小A', '111');
  const m2 = msg('随便', '小B', '222');
  window.push('group:111', m1);
  window.push('group:222', m2);
  const history = [
    { key: 'group:111', sender: '小A', text: '吃啥', time: m1.time },
    { key: 'group:222', sender: '小B', text: '随便', time: m2.time },
  ];

  const state = collectState({
    adapter: { running: true, url: 'ws://x/' },
    window,
    router,
    summaries,
    history,
    config: { adapter: 'onebot', dryRun: true },
    version: '0.0.4',
  });

  assert.equal(state.connection.connected, true);
  assert.equal(state.config.dryRun, true);
  assert.equal(state.sessions.length, 2, '路由的和出现过的都要列出来');
  const routed = state.sessions.find((s) => s.key === 'group:111');
  const loose = state.sessions.find((s) => s.key === 'group:222');
  assert.equal(routed.routed, true);
  assert.equal(routed.summary, '在聊晚饭');
  assert.equal(loose.routed, false, '没配路由的标出来');
  assert.equal(state.recent.length, 2);
  assert.equal(state.recent[0].key, 'group:222', 'recent 按时间倒序');
});

test('collectState：空数据不崩', () => {
  const state = collectState({
    adapter: undefined,
    window: createContextWindow(5),
    router: createRouter([]),
    summaries: new Map(),
    history: [],
    config: {},
    version: '0.0.4',
  });
  assert.deepEqual(state.sessions, []);
  assert.deepEqual(state.recent, []);
  assert.equal(state.connection.connected, false);
});

test('renderPanelHtml 产出完整页面且不注入脚本', () => {
  const html = renderPanelHtml();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /api\/state/);
  assert.match(html, /工作区会话/);
  assert.match(html, /情绪监控/, '要有情绪监控区块');
  assert.match(html, /id="chart"/, '要有情绪曲线画布');
  assert.ok(!html.includes('</script><script'), '只有一个脚本块');
});

test('polarityOf：正负面词各走各的方向', () => {
  assert.equal(polarityOf(''), 0);
  assert.equal(polarityOf('无'), 0);
  assert.ok(polarityOf('被夸了 美滋滋，来劲了') > 0, '正面');
  assert.ok(polarityOf('被怼得有点不爽，不想理他') < 0, '负面');
  assert.ok(polarityOf('有点懵，没兴趣') < polarityOf('平静'), '负面往负里走');
  // 再多的词也只压到 -1..1
  assert.ok(polarityOf('开心 高兴 爽 乐 笑 得意'.repeat(3)) <= 1);
  assert.ok(polarityOf('不爽 烦 气 无语 难受'.repeat(3)) >= -1);
});

test('pushMoodPoint：去重、限长、会截断最老的', () => {
  const hist = [];
  const t = 1793248000000;
  pushMoodPoint(hist, { at: t, sessionKey: 'group:1', mood: '有点爽' });
  assert.equal(hist.length, 1);
  // 同一会话同一情绪、一分钟内：只更新时间，不新增点
  pushMoodPoint(hist, { at: t + 20000, sessionKey: 'group:1', mood: '有点爽' });
  assert.equal(hist.length, 1);
  assert.equal(hist[0].at, t + 20000);
  // 过了去重窗口（5 分钟）就新增
  pushMoodPoint(hist, { at: t + 320000, sessionKey: 'group:1', mood: '有点爽' });
  assert.equal(hist.length, 2);
  // 换会话也新增
  pushMoodPoint(hist, { at: t + 330000, sessionKey: 'group:2', mood: '有点爽' });
  assert.equal(hist.length, 3);

  for (let i = 0; i < MOOD_HISTORY_MAX + 20; i += 1) {
    pushMoodPoint(hist, { at: t + i * 1000, sessionKey: 'group:x', mood: '情绪' + i });
  }
  assert.equal(hist.length, MOOD_HISTORY_MAX, '超出上限要截断');
});

test('collectState：带出情绪历史', () => {
  const moodHistory = [
    { at: 1, sessionKey: 'group:1', mood: '有点不爽', polarity: -0.5 },
    { at: 2, sessionKey: 'group:1', mood: '来劲了', polarity: 0.5 },
  ];
  const state = collectState({
    adapter: undefined,
    window: createContextWindow(5),
    router: createRouter([]),
    summaries: new Map(),
    history: [],
    config: {},
    version: '0.0.4',
    moodHistory,
  });
  assert.equal(state.moodHistory.points.length, 2);
  assert.equal(state.moodHistory.latest.mood, '来劲了');
});

test('collectState：没有情绪历史也不崩', () => {
  const state = collectState({
    adapter: undefined,
    window: createContextWindow(5),
    router: createRouter([]),
    summaries: new Map(),
    history: [],
    config: {},
    version: '0.0.4',
  });
  assert.deepEqual(state.moodHistory.points, []);
  assert.equal(state.moodHistory.latest, null);
});
