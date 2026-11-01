import test from 'node:test';
import assert from 'node:assert/strict';

import { loadImage, loadImagesFromMessages } from '../src/image.js';
import { makeMessage, toSegments } from '../src/message.js';

/** 造一个假的 fetch：按 URL 返回不同的图。 */
function fakeFetch(map) {
  return async (url) => {
    const hit = map[url];
    if (!hit) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    return {
      ok: true,
      headers: {
        get: (k) => {
          const lower = k.toLowerCase();
          if (lower === 'content-type') return hit.type ?? null;
          if (lower === 'content-length') return String(hit.bytes?.length ?? 0);
          return null;
        },
      },
      arrayBuffer: async () => hit.bytes.buffer.slice(hit.bytes.byteOffset, hit.bytes.byteOffset + hit.bytes.length),
    };
  };
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);

const msgWithImages = (urls) =>
  makeMessage({
    chatKind: 'group',
    chatId: '1',
    sender: { id: 'u', name: '甲' },
    segments: toSegments(urls.map((url, i) => ({ type: 'image', data: { url, file: `f${i}.png` } }))),
  });

test('loadImage：下载并转成 base64 多模态块', async () => {
  const fetchImpl = fakeFetch({ 'http://x/a.png': { type: 'image/png', bytes: png } });
  const out = await loadImage({ url: 'http://x/a.png' }, { fetchImpl });
  assert.ok(out);
  assert.equal(out.mediaType, 'image/png');
  assert.equal(Buffer.from(out.data, 'base64').length, png.length);
  assert.ok(out.name);
});

test('loadImage：没有 url 返回 null', async () => {
  assert.equal(await loadImage({}, { fetchImpl: fakeFetch({}) }), null);
});

test('loadImage：404 或非图片类型返回 null', async () => {
  const fetchImpl = fakeFetch({
    'http://x/404.png': undefined,
    'http://x/page': { type: 'text/html', bytes: png },
  });
  assert.equal(await loadImage({ url: 'http://x/404.png' }, { fetchImpl }), null);
  assert.equal(await loadImage({ url: 'http://x/page' }, { fetchImpl }), null);
});

test('loadImage：响应头没给类型时按扩展名猜', async () => {
  const fetchImpl = fakeFetch({ 'http://x/b.jpg': { bytes: jpg } });
  const out = await loadImage({ url: 'http://x/b.jpg' }, { fetchImpl });
  assert.equal(out.mediaType, 'image/jpeg');
});

test('loadImage：超过 maxBytes 直接放弃', async () => {
  const big = Buffer.alloc(2048, 1);
  const fetchImpl = fakeFetch({ 'http://x/big.png': { type: 'image/png', bytes: big } });
  assert.equal(await loadImage({ url: 'http://x/big.png' }, { fetchImpl, maxBytes: 1024 }), null);
});

test('loadImage：下载抛错也返回 null，不往上炸', async () => {
  const fetchImpl = async () => {
    throw new Error('网络断了');
  };
  assert.equal(await loadImage({ url: 'http://x/c.png' }, { fetchImpl }), null);
});

test('loadImagesFromMessages：只取最近 maxImages 张', async () => {
  const fetchImpl = fakeFetch({
    'http://x/1.png': { type: 'image/png', bytes: png },
    'http://x/2.png': { type: 'image/png', bytes: png },
    'http://x/3.png': { type: 'image/png', bytes: png },
  });
  const msgs = [msgWithImages(['http://x/1.png', 'http://x/2.png', 'http://x/3.png'])];
  const out = await loadImagesFromMessages(msgs, { fetchImpl, maxImages: 2 });
  assert.equal(out.length, 2, '只取最近的 2 张');
});

test('loadImagesFromMessages：maxImages=0 直接不取', async () => {
  const out = await loadImagesFromMessages([msgWithImages(['http://x/1.png'])], { fetchImpl: fakeFetch({}), maxImages: 0 });
  assert.deepEqual(out, []);
});

test('loadImagesFromMessages：没图的消息返回空数组', async () => {
  const plain = makeMessage({
    chatKind: 'group',
    chatId: '1',
    sender: { id: 'u' },
    segments: toSegments([{ type: 'text', data: { text: 'hi' } }]),
  });
  assert.deepEqual(await loadImagesFromMessages([plain], { fetchImpl: fakeFetch({}) }), []);
});

test('loadImagesFromMessages：每张图带上发送人和序号（和正文 [图N] 对上）', async () => {
  const t = 1793500000000;
  const msgs = [
    { id: 'm1', sender: { id: '1001', name: '甲' }, segments: [{ type: 'text', text: '看' }, { type: 'image', url: 'http://x/1.png' }], time: t },
    { id: 'm2', sender: { id: '1002', name: '乙' }, segments: [{ type: 'image', url: 'http://x/2.png' }], time: t + 1000 },
  ];
  const fetchImpl = fakeFetch({
    'http://x/1.png': { type: 'image/png', bytes: png },
    'http://x/2.png': { type: 'image/png', bytes: png },
  });
  const imgs = await loadImagesFromMessages(msgs, { fetchImpl });
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].sender, '甲', '第一张是甲发的');
  assert.equal(imgs[0].senderId, '1001');
  assert.equal(imgs[0].at, t);
  assert.equal(imgs[0].messageId, 'm1');
  assert.equal(imgs[0].index, 1, '要有顺序号，和正文里的 [图1] 对上');
  assert.equal(imgs[1].sender, '乙');
  assert.equal(imgs[1].index, 2);
});
