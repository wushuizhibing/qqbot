/**
 * 视频抽帧：把视频片段变成几张图交给模型看。
 *
 * 为什么要抽帧而不是直接喂视频：多模态输入只吃图片，
 * 群里的短视频又经常是信息主体（游戏战绩、翻车现场），不抽等于看不见。
 *
 * 流程：下载到临时文件 → ffprobe 拿时长 → ffmpeg 均匀抽 N 帧 → 读回 base64 → 清理
 *
 * 失败一律返回空数组：抽不出帧就当没视频，绝不能让整轮思考挂掉。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_FRAMES = 3;
const DEFAULT_MAX_BYTES = 30 * 1024 * 1024; // 视频比图大，放宽到 30MB
const DOWNLOAD_TIMEOUT_MS = 20000;
const EXEC_TIMEOUT_MS = 20000;

/**
 * 跑一个可执行文件，返回 stdout（失败返回 null）。
 * @param {string} bin
 * @param {string[]} args
 */
function run(bin, args) {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        resolve(error ? null : String(stdout ?? ''));
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * 探测视频时长（秒）；拿不到就返回 0。
 * @param {string} ffprobe
 * @param {string} file
 */
async function probeDuration(ffprobe, file) {
  const out = await run(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const seconds = Number(String(out ?? '').trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/**
 * 抽帧。
 * @param {{ url?: string }} segment 视频段
 * @param {{
 *   ffmpeg?: string,
 *   ffprobe?: string,
 *   frames?: number,
 *   maxBytes?: number,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 * @returns {Promise<Array<{ data: string, mediaType: string, name: string }>>}
 */
export async function extractFrames(segment, options = {}) {
  const url = segment?.url;
  const ffmpeg = options.ffmpeg;
  if (!url || !ffmpeg) return [];
  const ffprobe = options.ffprobe || ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  const wantFrames = Math.max(1, Math.min(6, options.frames ?? DEFAULT_FRAMES));
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return [];

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qqkit-video-'));
  const videoPath = path.join(dir, 'clip');
  try {
    // 1) 下载
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    const res = await doFetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res?.ok) return [];
    const declared = Number(res.headers?.get?.('content-length') ?? 0);
    if (declared && declared > maxBytes) return [];
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > maxBytes) return [];
    await fs.writeFile(videoPath, buf);

    // 2) 时长 → 均匀取点
    const duration = await probeDuration(ffprobe, videoPath);
    const points = [];
    if (duration > 0) {
      for (let i = 0; i < wantFrames; i += 1) {
        // 掐头去尾：两头经常是黑场
        points.push((duration * (i + 0.5)) / wantFrames);
      }
    }

    // 3) 抽帧：按时间点各抓一张；拿不到时长就退回 fps 抽
    const pattern = path.join(dir, 'frame%02d.png');
    if (points.length) {
      for (let i = 0; i < points.length; i += 1) {
        await run(ffmpeg, [
          '-y', '-v', 'error',
          '-ss', points[i].toFixed(2),
          '-i', videoPath,
          '-frames:v', '1',
          '-vf', 'scale=1024:-1',
          path.join(dir, `frame${String(i + 1).padStart(2, '0')}.png`),
        ]);
      }
    } else {
      await run(ffmpeg, [
        '-y', '-v', 'error',
        '-i', videoPath,
        '-vf', `fps=1,scale=1024:-1`,
        '-frames:v', String(wantFrames),
        pattern,
      ]);
    }

    // 4) 读回
    const files = (await fs.readdir(dir)).filter((f) => /^frame\d+\.png$/.test(f)).sort();
    const images = [];
    for (const file of files.slice(0, wantFrames)) {
      const bytes = await fs.readFile(path.join(dir, file));
      if (bytes.length === 0) continue;
      images.push({
        data: bytes.toString('base64'),
        mediaType: 'image/png',
        name: `qq-video-${images.length + 1}`,
      });
    }
    return images;
  } catch {
    return [];
  } finally {
    // 临时目录一定清掉，视频可能几十兆
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 把一批消息里的视频都抽成帧（最多 maxVideos 个视频）。
 * @param {import('./message.js').Message[]} messages
 * @param {{ maxVideos?: number, framesPerVideo?: number } & Parameters<typeof extractFrames>[1]} [options]
 */
export async function loadFramesFromMessages(messages, options = {}) {
  const maxVideos = Math.max(0, options.maxVideos ?? 1);
  if (maxVideos === 0) return [];
  /** @type {Array<{ url?: string }>} */
  const videos = [];
  for (const msg of messages ?? []) {
    for (const seg of msg?.segments ?? []) {
      if (seg?.type === 'video' && seg.url) videos.push(seg);
    }
  }
  const picked = videos.slice(-maxVideos);
  const groups = await Promise.all(
    picked.map((seg) => extractFrames(seg, { ...options, frames: options.framesPerVideo ?? 3 })),
  );
  return groups.flat();
}
