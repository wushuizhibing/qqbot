/**
 * 图片获取：把消息里的图片段变成子代理能看的多模态输入。
 *
 * QQ 的图片 URL 有时效（几分钟到几小时），所以必须在收到消息时立刻下载，
 * 不能等思考子代理跑起来才去要。
 *
 * 约束（DSH 那边的限额，超了 prompt 会被拒）：
 *   - 单图不能太大，这里默认 4MB 上限，超了跳过而不是硬塞
 *   - 只认 png / jpeg / webp / gif（多模态输入支持的类型）
 */

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;

/** 允许作为多模态输入的 MIME。 */
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * 从 URL 猜 MIME（响应头没给时兜底）。
 * @param {string} url
 */
function guessMime(url) {
  const clean = String(url).split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.gif')) return 'image/gif';
  return '';
}

/**
 * 下载一张图并转成多模态块。
 * @param {{ url?: string }} segment
 * @param {{ maxBytes?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ data: string, mediaType: string, name: string } | null>}
 */
export async function loadImage(segment, options = {}) {
  const url = segment?.url;
  if (!url) return null;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await doFetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res?.ok) return null;

    // 先看声明长度，太大直接放弃，别把整个响应拉下来
    const declared = Number(res.headers?.get?.('content-length') ?? 0);
    if (declared && declared > maxBytes) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > maxBytes) return null;

    const headerType = String(res.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const mediaType = ALLOWED.has(headerType) ? headerType : guessMime(url);
    if (!ALLOWED.has(mediaType)) return null;

    return {
      data: buf.toString('base64'),
      mediaType,
      name: `qq-${Date.now()}-${buf.length}`,
    };
  } catch {
    // 下载失败就当没图；不能让整轮思考因为一张图挂掉
    return null;
  }
}

/**
 * 把一批消息里的图片都拉下来（最多 maxImages 张，取最近的）。
 *
 * 每张图都带上"谁发的、什么时候发的、原消息是哪条"——
 * 不然模型看到几张图却不知道对应哪句话，只能瞎猜。
 *
 * @param {import('./message.js').Message[]} messages
 * @param {{ maxImages?: number, maxBytes?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<Array<{
 *   data: string, mediaType: string, name: string,
 *   sender: string, senderId: string, at: number, messageId: string, index: number,
 * }>>}
 */
export async function loadImagesFromMessages(messages, options = {}) {
  const maxImages = Math.max(0, options.maxImages ?? 3);
  if (maxImages === 0) return [];

  // 收集时就把"这段属于哪条消息、谁发的"记下来
  /** @type {Array<{ seg: any, msg: any }>} */
  const collected = [];
  for (const msg of messages ?? []) {
    for (const seg of msg?.segments ?? []) {
      if (seg?.type === 'image' && seg.url) collected.push({ seg, msg });
    }
  }
  // 取最近的几张
  const picked = collected.slice(-maxImages);
  const results = await Promise.all(
    picked.map(async ({ seg, msg }, i) => {
      const loaded = await loadImage(seg, options);
      if (!loaded) return null;
      return {
        ...loaded,
        // 归因信息：模型靠这个知道"这张图是甲发的，配的是他那句'看这个'"
        sender: String(msg?.sender?.name ?? msg?.sender?.id ?? '?'),
        senderId: String(msg?.sender?.id ?? ''),
        at: Number(msg?.time) || 0,
        messageId: String(msg?.id ?? ''),
        index: i + 1,
      };
    }),
  );
  return results.filter(Boolean);
}
