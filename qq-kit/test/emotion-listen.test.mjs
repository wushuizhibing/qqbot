import test from 'node:test';
import assert from 'node:assert/strict';

import { createTwoStageBridge } from '../src/bridge.js';
import { createContextWindow } from '../src/session.js';
import { makeMessage, toSegments } from '../src/message.js';
import { carryMood } from '../src/emotion.js';

const msg = (text, name = '甲', id = '10001') =>
  makeMessage({
    chatKind: 'group',
    chatId: '1',
    sender: { id, name },
    segments: toSegments([{ type: 'text', data: { text } }]),
  });

/**
 * 监听试验的离线版：假子代理按"剧本"回 mood，验证连续几轮里情绪怎么流动。
 * 真机版见 experiments/emotion-listen/（只记录不发送）。
 */

function scriptedSummarizer(script) {
  let call = 0;
  return {
    async summarize(ctx) {
      const step = script[Math.min(call, script.length - 1)];
      call += 1;
      return { text: step.text, facts: [], covered: ctx.window.length, mood: step.mood };
    },
  };
}

async function runScript(script, rounds) {
  const window = createContextWindow(20);
  const seen = [];
  const bridge = createTwoStageBridge({
    summarizer: scriptedSummarizer(script),
    thinker: {
      async think(ctx) {
        seen.push({ mood: ctx.mood, prevMood: ctx.summary?.mood ?? '' });
        const last = ctx.messages.at(-1);
        return { chatKind: 'group', chatId: '1', segments: [{ type: 'text', text: '嗯' }], mode: 'reply' };
      },
    },
    window,
  });
  let previous = null;
  const moods = [];
  for (let i = 0; i < rounds; i += 1) {
    const messages = [msg(`第${i + 1}轮`)];
    for (const m of messages) window.push('group:1', m);
    const out = await bridge.run({
      sessionKey: 'group:1',
      route: {},
      messages,
      window: window.get('group:1'),
      summary: previous,
    });
    // 插件里的"防一下清空"逻辑
    previous = carryMood(out.summary, i === 0 ? null : previous);
    moods.push(previous.mood);
  }
  return { moods, seen };
}

test('监听试验：被怼 → 崩住 → 转成别的情绪，一路都有迹可循', async () => {
  const script = [
    { text: '被说菜', mood: '被老王说菜，不太爽' },
    { text: '在聊别的', mood: '无' },
    { text: '摸鱼', mood: '无' },
    { text: '有人喊开黑', mood: '有人喊上号，来了精神' },
  ];
  const { moods } = await runScript(script, 4);
  assert.equal(moods[0], '被老王说菜，不太爽');
  // 2026-10-31：残留情绪不再截短文字（会变成残句），改为强度衰减
  assert.equal(moods[1], moods[0], '第 2 轮文字保持完整');
  assert.equal(moods[2], moods[1], '第 3 轮文字仍完整');
  assert.equal(moods[3], '有人喊上号，来了精神', '新情绪直接覆盖旧的');
});

test('监听试验：情绪断了也别崩 —— 模型回 null/空都能跑', async () => {
  const script = [
    { text: 'a', mood: null },
    { text: 'b', mood: undefined },
    { text: 'c', mood: '   ' },
  ];
  const { moods } = await runScript(script, 3);
  assert.deepEqual(moods, ['', '', '']);
});

test('监听试验：思考子代理每轮都拿得到"这一轮的情绪"', async () => {
  const script = [
    { text: 'a', mood: '被夸了 美滋滋' },
    { text: 'b', mood: '无' },
  ];
  const { seen } = await runScript(script, 2);
  assert.equal(seen[0].mood, '被夸了 美滋滋');
  // 第 2 轮：摘要自己说"无"，思考子代理看到的也是空（减半在插件层做，不假装有情绪）
  assert.equal(seen[1].mood, '');
});
