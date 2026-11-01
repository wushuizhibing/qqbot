import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCqCode, toSegments, toPlainText } from '../src/message.js';
import { toCqCode } from '../adapters/onebot.js';

test('parseCqCode：文本 + at + 图片 + 回复', () => {
  const segs = parseCqCode('[CQ:reply,id=123][CQ:at,qq=456789] 你好 [CQ:image,file=abc.jpg,url=https://x/y.jpg]');
  assert.deepEqual(segs[0], { type: 'reply', id: '123' });
  assert.deepEqual(segs[1], { type: 'at', id: '456789', name: undefined });
  assert.equal(segs[2].type, 'text');
  assert.equal(segs[2].text.trim(), '你好');
  assert.equal(segs[3].type, 'image');
  assert.equal(segs[3].file, 'abc.jpg');
  assert.equal(segs[3].url, 'https://x/y.jpg');
});

test('parseCqCode：未知类型降级成 unknown，但文本不丢', () => {
  const segs = parseCqCode('前 [CQ:face,id=1] 后');
  assert.equal(segs.length, 3);
  assert.equal(segs[1].type, 'unknown');
  assert.equal(segs[0].text, '前 ');
  assert.equal(segs[2].text, ' 后');
});

test('parseCqCode：反转义 &amp; &#91; 等', () => {
  const segs = parseCqCode('[CQ:at,qq=1,name=a&#44;b] &amp; &#91;测试&#93;');
  assert.equal(segs[0].name, 'a,b');
  assert.equal(segs[1].text, ' & [测试]');
});

test('parseCqCode：纯文本和空串', () => {
  assert.deepEqual(parseCqCode('普通消息'), [{ type: 'text', text: '普通消息' }]);
  assert.deepEqual(parseCqCode(''), []);
});

test('toSegments 接受 CQ 字符串和段数组两种输入', () => {
  assert.equal(toSegments('[CQ:at,qq=1] 在吗')[0].type, 'at');
  assert.equal(toSegments([{ type: 'text', data: { text: 'hi' } }])[0].text, 'hi');
});

test('toCqCode：内部段回写成 CQ 码，特殊字符转义', () => {
  const cq = toCqCode([
    { type: 'reply', id: '9' },
    { type: 'at', id: '123' },
    { type: 'text', text: 'a,b [c] &d' },
    { type: 'image', url: 'https://x/i.png' },
  ]);
  assert.equal(cq, '[CQ:reply,id=9][CQ:at,qq=123]a&#44;b &#91;c&#93; &amp;d[CQ:image,file=https://x/i.png]');
});

test('CQ 往返：解析后再回写，结构不丢', () => {
  const src = '[CQ:at,qq=100] 嗨';
  const segs = parseCqCode(src);
  assert.equal(toCqCode(segs), '[CQ:at,qq=100] 嗨');
  assert.equal(toPlainText(segs), '@ 嗨');
});
