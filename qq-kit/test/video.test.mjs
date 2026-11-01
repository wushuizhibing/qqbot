import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractFrames, loadFramesFromMessages } from '../src/video.js';
import { makeMessage, toSegments, toPlainText } from '../src/message.js';

const FFMPEG = 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const hasFfmpeg = fs.existsSync(FFMPEG);

const videoMsg = (url) =>
  makeMessage({
    chatKind: 'group',
    chatId: '1',
    sender: { id: 'u', name: '甲' },
    segments: toSegments([{ type: 'video', data: { url, file: 'v.mp4' } }]),
  });

/** 造一个可用的测试视频（5 秒彩条）。 */
function makeTestVideo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqkit-vid-'));
  const file = path.join(dir, 't.mp4');
  const { execFileSync } = require('node:child_process');
  execFileSync(FFMPEG, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file,
  ]);
  return file;
}
// 这个测试文件用 ESM，但 execFileSync 要 require —— 用 createRequire 拿
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('视频段解析成 video 类型，文本降级成 [视频]', () => {
  const segs = toSegments([{ type: 'video', data: { url: 'http://x/v.mp4' } }]);
  assert.equal(segs[0].type, 'video');
  assert.equal(segs[0].url, 'http://x/v.mp4');
  assert.equal(toPlainText(segs), '[视频]');
});

test('没有 ffmpeg 路径时直接返回空（不启用抽帧）', async () => {
  const out = await extractFrames({ url: 'http://x/v.mp4' }, {});
  assert.deepEqual(out, []);
});

test('没有 url 时返回空', async () => {
  const out = await extractFrames({}, { ffmpeg: FFMPEG });
  assert.deepEqual(out, []);
});

test('下载失败时返回空，不抛错', async () => {
  const fetchImpl = async () => ({ ok: false, headers: { get: () => null } });
  const out = await extractFrames({ url: 'http://x/v.mp4' }, { ffmpeg: FFMPEG, fetchImpl });
  assert.deepEqual(out, []);
});

test('真实视频抽帧：拿到 png 帧', { skip: !hasFfmpeg && '没装 ffmpeg' }, async () => {
  const file = makeTestVideo();
  const bytes = fs.readFileSync(file);
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  });
  const out = await extractFrames({ url: 'http://x/v.mp4' }, { ffmpeg: FFMPEG, frames: 3, fetchImpl });
  assert.ok(out.length >= 1, `至少抽到一帧，实际 ${out.length}`);
  assert.ok(out.length <= 3, '不超过请求的帧数');
  assert.equal(out[0].mediaType, 'image/png');
  // png magic
  const buf = Buffer.from(out[0].data, 'base64');
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('loadFramesFromMessages：只处理视频段，maxVideos=0 时不抽', async () => {
  const plain = makeMessage({
    chatKind: 'group',
    chatId: '1',
    sender: { id: 'u' },
    segments: toSegments([{ type: 'text', data: { text: 'hi' } }]),
  });
  assert.deepEqual(await loadFramesFromMessages([plain], { ffmpeg: FFMPEG }), []);
  assert.deepEqual(await loadFramesFromMessages([videoMsg('http://x/v.mp4')], { ffmpeg: FFMPEG, maxVideos: 0 }), []);
});
