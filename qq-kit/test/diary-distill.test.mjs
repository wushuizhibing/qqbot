import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderTranscript,
  buildDiaryPrompt,
  parseDiaryReply,
  createDiaryDistiller,
} from '../src/diary-distill.js';

test('renderTranscript：带时间、说话人、内容', () => {
  const t = renderTranscript([
    { sender: '甲', text: '你好', time: new Date(2026, 10, 3, 18, 20).getTime() },
  ]);
  assert.match(t, /11-03 18:20 甲: 你好/);
});

test('renderTranscript：空消息跳过', () => {
  const t = renderTranscript([
    { sender: '甲', text: '', time: Date.now() },
    { sender: '乙', text: '有内容', time: Date.now() },
  ]);
  assert.equal(t.split('\n').length, 1);
  assert.match(t, /乙: 有内容/);
});

test('buildDiaryPrompt：说清什么算关键、什么不算', () => {
  const p = buildDiaryPrompt(['甲', '乙'], '甲: 让我安静');
  assert.match(p, /关键事件/);
  assert.match(p, /对你（机器人）有要求的/);
  assert.match(p, /纯闲聊、打招呼、表情包/);
  assert.match(p, /不要硬凑/, '要允许返回空');
  assert.match(p, /甲、乙/);
});

test('parseDiaryReply：正常解析', () => {
  const got = parseDiaryReply('{"events":[{"name":"甲","text":"让我把情绪调淡"}]}');
  assert.equal(got.length, 1);
  assert.equal(got[0].name, '甲');
  assert.equal(got[0].text, '让我把情绪调淡');
});

test('parseDiaryReply：过滤"没有关键事件"这类人话', () => {
  const got = parseDiaryReply('{"events":[{"name":"甲","text":"无"},{"name":"乙","text":"没有"}]}');
  assert.equal(got.length, 0);
});

test('parseDiaryReply：缺字段的条目丢掉', () => {
  const got = parseDiaryReply('{"events":[{"name":"甲"},{"text":"有内容"},{"name":"乙","text":"完整"}]}');
  assert.equal(got.length, 1);
  assert.equal(got[0].name, '乙');
});

test('parseDiaryReply：坏 JSON 不炸', () => {
  assert.deepEqual(parseDiaryReply('不是 JSON'), []);
  assert.deepEqual(parseDiaryReply(''), []);
});

test('createDiaryDistiller：走一遍完整流程', async () => {
  let captured = '';
  const d = createDiaryDistiller(
    {
      agents: {
        runOnce: async (_n, prompt) => {
          captured = prompt;
          return JSON.stringify({ events: [{ name: '甲', text: '让我别太吵' }] });
        },
      },
    },
    { render: () => '甲: 你能不能安静点' },
  );
  const events = await d.distill({ names: ['甲'], records: [{ sender: '甲', text: 'x' }] });
  assert.equal(events.length, 1);
  assert.equal(events[0].text, '让我别太吵');
  assert.match(captured, /甲: 你能不能安静点/, '转写要进 prompt');
});

test('createDiaryDistiller：没有转写就跳过，不浪费调用', async () => {
  let called = false;
  const d = createDiaryDistiller(
    { agents: { runOnce: async () => { called = true; return '{}'; } } },
    { render: () => '   ' },
  );
  const events = await d.distill({ names: ['甲'], records: [] });
  assert.deepEqual(events, []);
  assert.equal(called, false, '没内容就不该调模型');
});

test('createDiaryDistiller：模型返回空就是空，不硬凑', async () => {
  const d = createDiaryDistiller(
    { agents: { runOnce: async () => '{"events":[]}' } },
    { render: () => '甲: 哈哈' },
  );
  assert.deepEqual(await d.distill({ names: ['甲'], records: [] }), []);
});
