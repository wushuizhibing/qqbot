/**
 * 内部消息结构（QQ Kit 的核心数据模型）。
 *
 * 这一层**刻意不依赖 OneBot**：协议端不管吐什么格式，
 * 适配器都先转成这里的结构，再往下走会话、合并发送、记忆。
 * 以后换协议端只换适配器，下面的东西不用动。
 */

/** 消息来源：群 / 私聊。 */
export const ChatKind = Object.freeze({
  Group: 'group',
  Private: 'private',
});

/**
 * 统一的发送者。
 * @typedef {{ id: string, name?: string, isSelf?: boolean }} Sender
 */

/**
 * 统一的消息段。只保留我们真正会用到的最小集合，
 * 其余类型一律降级成 text，保证不会因为协议端多了个新类型就崩。
 * @typedef {
 *   | { type: 'text', text: string }
 *   | { type: 'image', url?: string, file?: string }
 *   | { type: 'video', url?: string, file?: string }
 *   | { type: 'at', id: string, name?: string }
 *   | { type: 'reply', id: string }
 *   | { type: 'file', url?: string, file?: string, name?: string }
 *   | { type: 'unknown', raw: unknown }
 * } Segment
 */

/**
 * 统一的一条 QQ 消息。
 * @typedef {object} Message
 * @property {string} id            协议端里的消息 id
 * @property {'group'|'private'} chatKind
 * @property {string} chatId        群号或对方 QQ 号
 * @property {Sender} sender
 * @property {Segment[]} segments
 * @property {number} time          毫秒时间戳
 */

let seq = 0;

/**
 * 生成一个内部消息对象，补齐默认值。
 * @param {Partial<Message> & { chatKind: 'group'|'private', chatId: string, sender: Sender }} input
 * @returns {Message}
 */
export function makeMessage(input) {
  seq += 1;
  return {
    id: input.id ?? `local-${Date.now()}-${seq}`,
    chatKind: input.chatKind,
    chatId: String(input.chatId),
    sender: input.sender,
    segments: input.segments ?? [],
    time: input.time ?? Date.now(),
  };
}

/**
 * 把任意协议端消息段降级成内部段。
 * @param {unknown} seg
 * @returns {Segment}
 */
export function toSegment(seg) {
  if (!seg || typeof seg !== 'object') return { type: 'unknown', raw: seg };
  const type = String(seg.type ?? '');
  const data = /** @type {Record<string, unknown>} */ (seg.data ?? {});
  switch (type) {
    case 'text':
      return { type: 'text', text: String(data.text ?? '') };
    case 'image':
      return { type: 'image', url: data.url ? String(data.url) : undefined, file: data.file ? String(data.file) : undefined };
    case 'video':
    case 'record':
      // 视频/语音：抽帧识图只需要 url，跟图片一样带下来
      return { type: 'video', url: data.url ? String(data.url) : undefined, file: data.file ? String(data.file) : undefined };
    case 'at':
      return { type: 'at', id: String(data.qq ?? data.id ?? ''), name: data.name ? String(data.name) : undefined };
    case 'reply':
      return { type: 'reply', id: String(data.id ?? '') };
    case 'file':
      return {
        type: 'file',
        url: data.url ? String(data.url) : undefined,
        file: data.file ? String(data.file) : undefined,
        name: data.name ? String(data.name) : undefined,
      };
    default:
      return { type: 'unknown', raw: seg };
  }
}

/**
 * 把消息段解析成内部段。
 * 支持三种输入：
 *   - 段数组（OneBot array 格式）
 *   - CQ 码字符串（OneBot string 格式，如 `[CQ:at,qq=123] 你好`）
 *   - 纯文本字符串
 * @param {unknown} segments
 * @returns {Segment[]}
 */
export function toSegments(segments) {
  if (typeof segments === 'string') return parseCqCode(segments);
  if (!Array.isArray(segments)) return [];
  return segments.map(toSegment);
}

/**
 * 解析 CQ 码。这是 OneBot string 格式的实际载体。
 * 规则：`[CQ:type,key=value,key=value]`，值里的 `&#91;` `&#93;` `&#44;` `&amp;` 需要反转义。
 * 不认识的 CQ 类型一律降级成 unknown（保住原文，别丢）。
 * @param {string} text
 * @returns {Segment[]}
 */
export function parseCqCode(text) {
  if (typeof text !== 'string' || text === '') return [];
  /** @type {Segment[]} */
  const out = [];
  const re = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      const plain = unescapeCq(text.slice(last, m.index));
      if (plain) out.push({ type: 'text', text: plain });
    }
    const type = m[1];
    const params = parseCqParams(m[2] ?? '');
    switch (type) {
      case 'at':
        out.push({ type: 'at', id: String(params.qq ?? ''), name: params.name });
        break;
      case 'image':
        out.push({ type: 'image', url: params.url, file: params.file });
        break;
      case 'video':
      case 'record':
        out.push({ type: 'video', url: params.url, file: params.file });
        break;
      case 'reply':
        out.push({ type: 'reply', id: String(params.id ?? '') });
        break;
      case 'file':
        out.push({ type: 'file', url: params.url, file: params.file, name: params.name });
        break;
      default:
        out.push({ type: 'unknown', raw: m[0] });
        break;
    }
    last = re.lastIndex;
  }
  if (last < text.length) {
    const plain = unescapeCq(text.slice(last));
    if (plain) out.push({ type: 'text', text: plain });
  }
  if (out.length === 0) {
    const plain = unescapeCq(text);
    if (plain) out.push({ type: 'text', text: plain });
  }
  return out;
}

/**
 * 这条消息有没有 @ 某个号。
 * 支持三种写法：@我（QQ 里是 at 段 qq=<自身号>）、@全体成员（qq=all）、@指定号。
 * @param {import('./message.js').Message} msg
 * @param {{ selfId?: string, anyAt?: boolean }} [options]
 * @returns {boolean}
 */
export function isMention(msg, options = {}) {
  const ats = (msg?.segments ?? []).filter((s) => s.type === 'at');
  if (ats.length === 0) return false;
  if (options.anyAt) return true;
  const self = String(options.selfId ?? '').trim();
  return ats.some((s) => {
    const id = String(s.id ?? '');
    if (id === 'all') return true; // 全体成员也算在叫大家
    if (self && id === self) return true;
    return false;
  });
}

/**
 * 解析 `,key=value,key=value` 形式的 CQ 参数。
 * @param {string} raw
 * @returns {Record<string, string>}
 */
function parseCqParams(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!raw) return out;
  for (const piece of raw.split(',')) {
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    const key = piece.slice(0, eq).trim();
    const value = unescapeCq(piece.slice(eq + 1).trim());
    if (key) out[key] = value;
  }
  return out;
}

/**
 * CQ 码转义还原。
 * @param {string} s
 */
function unescapeCq(s) {
  return s
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

/**
 * 把内部段拼成纯文本（给会话上下文、日志用）。
 * @param {Segment[]} segments
 * @returns {string}
 */
export function toPlainText(segments) {
  const parts = [];
  for (const s of segments) {
    switch (s.type) {
      case 'text':
        parts.push(s.text);
        break;
      case 'at':
        parts.push(s.name ? `@${s.name}` : '@');
        break;
      case 'image':
        parts.push('[图片]');
        break;
      case 'video':
        parts.push('[视频]');
        break;
      case 'file':
        parts.push(`[文件${s.name ? ':' + s.name : ''}]`);
        break;
      case 'reply':
        parts.push('[回复]');
        break;
      default:
        break;
    }
  }
  return parts.join('');
}

/**
 * 内部段 → 发送用的精简结构（适配器再翻译成协议端格式）。
 * @param {Segment[]} segments
 */
export function toOutboundSegments(segments) {
  return segments.map((s) => (s.type === 'unknown' ? { type: 'text', text: '' } : s));
}
