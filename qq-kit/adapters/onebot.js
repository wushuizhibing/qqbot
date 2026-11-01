/**
 * OneBot v11 适配器（WebSocket）。
 *
 * 连接 OneBot v11 实现的 WS 服务，把 OneBot 事件翻译成内部 Message，把内部 Segment
 * 翻译成 OneBot 动作发回去。适配器只做翻译，不建会话、不管记忆。
 *
 * 连接约定（实测 v2.2.1）：
 *   - WS 服务端 role=Universal、path=/ 时，同一条连接既收事件("/" 和 "/event")又能发动作("/api")
 *   - role=Event 只能收、不能发；role=Api 只能发、收不到事件。别拆成两条连接，没意义。
 *   - reportSelfMessage=true 时能看到机器人自己发的 message_sent，默认忽略，避免自激。
 *
 * 依赖：ws（支持自定义 Authorization header）。解析顺序见 loadWebSocket()。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AdapterBase } from '../src/adapter.js';
import { makeMessage, toSegments } from '../src/message.js';

const DEFAULT_URL = 'ws://127.0.0.1:3001/';
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export class OneBotAdapter extends AdapterBase {
  static get id() {
    return 'onebot';
  }

  constructor(options = {}) {
    super(options);
    this.url = options.url ?? DEFAULT_URL;
    this.accessToken = options.accessToken ?? '';
    this.selfId = options.selfId ?? '';
    /** 与协议端配置里的 messageFormat 保持一致；默认 string */
    this.messageFormat = options.messageFormat ?? 'string';
    this.ws = null;
    this.inflight = 0;
    this.echoSeq = 0;
    /** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
    this.pending = new Map();
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.closed = false;
  }

  async start() {
    if (this.closed) return;
    const { WebSocket, supportsHeaders } = await loadWebSocket();
    if (this.accessToken && !supportsHeaders) {
      this.emitError(new Error('当前 WebSocket 实现不支持自定义 header，无法带 accessToken：请安装 ws'));
      return;
    }
    const headers = this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {};
    const ws = this.accessToken ? new WebSocket(this.url, { headers }) : new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      this.running = true;
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.emitStatus({ connected: true, detail: this.url });
    });

    ws.on('message', (raw) => {
      let payload;
      try {
        payload = JSON.parse(String(raw));
      } catch (error) {
        this.emitError(new Error(`收到非 JSON 帧: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      try {
        this.dispatch(payload);
      } catch (error) {
        // 单帧处理失败不能断掉连接
        this.emitError(error);
      }
    });

    ws.on('close', () => {
      this.running = false;
      this.failPending(new Error('WebSocket 已关闭'));
      if (!this.closed) {
        this.emitStatus({ connected: false, detail: '连接断开，准备重连' });
        this.scheduleReconnect();
      }
    });

    ws.on('error', (error) => {
      this.emitError(error);
      // 连不上时 ws 只发 error、不一定发 close：这里必须自己排重连，
      // 否则启动时服务端没开（ECONNREFUSED）就再也不重试了。
      if (!this.closed) {
        this.running = false;
        this.scheduleReconnect();
      }
    });
  }

  async stop() {
    this.closed = true;
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.failPending(new Error('适配器已停止'));
    try {
      this.ws?.close();
    } catch {
      /* 关闭失败不影响调用方 */
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.closed) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(RECONNECT_MAX_MS, delay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // start() 同步抛错（比如 WebSocket 实现缺失）也要继续排重连，不能就此沉默
      Promise.resolve()
        .then(() => this.start())
        .catch((error) => {
          this.emitError(error);
          this.scheduleReconnect();
        });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /**
   * 事件分发：只有 message / message_sent 进业务，其余忽略。
   * @param {any} payload
   */
  dispatch(payload) {
    // 动作响应（带 echo）要优先处理，别当事件
    if (payload?.echo != null) {
      const waiter = this.pending.get(String(payload.echo));
      if (waiter) {
        this.pending.delete(String(payload.echo));
        clearTimeout(waiter.timer);
        if (payload.status === 'failed' || payload.retcode) {
          waiter.reject(new Error(payload.wording || payload.message || `动作失败: ${payload.retcode}`));
        } else {
          waiter.resolve(payload.data);
        }
      }
      return;
    }

    if (payload?.post_type !== 'message' && payload?.post_type !== 'message_sent') return;

    try {
      const msg = fromOneBot(payload);
      if (!msg) return;
      // 自己的号发出去的消息默认不回，避免自激
      if (payload.post_type === 'message_sent' && !this.options.echoSelf) return;
      this.emitMessage(msg);
    } catch (error) {
      this.emitError(error);
    }
  }

  /**
   * 调用 OneBot 动作。
   * @param {string} action
   * @param {Record<string, unknown>} params
   * @returns {Promise<any>}
   */
  call(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new Error(`WebSocket 未连接，无法调用 ${action}`));
        return;
      }
      this.echoSeq += 1;
      const echo = `dsh-${this.echoSeq}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`${action} 超时`));
      }, this.options.requestTimeoutMs ?? 20000);
      timer.unref?.();
      this.pending.set(echo, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  failPending(error) {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  /**
   * 发消息。按配置决定用 CQ 码字符串还是段数组：
   * 协议端必须配 `messageFormat: "string"`（array 模式下事件推不出来），
   * 所以默认发 CQ 字符串。
   */
  async send({ chatKind, chatId, segments }) {
    const action = chatKind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = {
      [chatKind === 'private' ? 'user_id' : 'group_id']: toOneBotId(chatId),
      message: this.messageFormat === 'array' ? toOneBotSegments(segments) : toCqCode(segments),
    };
    const data = await this.call(action, params);
    return { messageId: data?.message_id != null ? String(data.message_id) : undefined };
  }

  /** 补一点群/好友信息，给会话取名用 */
  async groupInfo(groupId) {
    return this.call('get_group_info', { group_id: toOneBotId(groupId) });
  }

  async strangerInfo(userId) {
    return this.call('get_stranger_info', { user_id: toOneBotId(userId) });
  }
}

/**
 * OneBot 事件 → 内部消息。
 * @param {any} payload
 */
export function fromOneBot(payload) {
  const chatKind = payload.message_type === 'private' ? 'private' : 'group';
  const chatId = String(chatKind === 'group' ? payload.group_id : payload.user_id);
  const senderRaw = payload.sender ?? {};
  const sender = {
    id: String(payload.user_id ?? ''),

    name: senderRaw.card || senderRaw.nickname || String(payload.user_id ?? ''),
  };
  return makeMessage({
    id: payload.message_id != null ? String(payload.message_id) : undefined,
    chatKind,
    chatId,
    sender,
    segments: toSegments(payload.message),
    time: payload.time ? Number(payload.time) * 1000 : Date.now(),
  });
}

/**
 * 内部段 → OneBot 消息段数组。
 * @param {import('../src/message.js').Segment[]} segments
 */
export function toOneBotSegments(segments) {
  const out = [];
  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        if (seg.text) out.push({ type: 'text', data: { text: seg.text } });
        break;
      case 'at':
        out.push({ type: 'at', data: { qq: seg.id } });
        break;
      case 'image':
        out.push({ type: 'image', data: seg.url ? { file: seg.url } : { file: seg.file ?? '' } });
        break;
      case 'reply':
        out.push({ type: 'reply', data: { id: seg.id } });
        break;
      case 'file':
        out.push({ type: 'file', data: { file: seg.url ?? seg.file ?? '', name: seg.name ?? '' } });
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * 内部段 → CQ 码字符串（OneBot string 格式）。
 *
 * 为什么需要：部分协议端在 `messageFormat: "array"` 下消息事件推不出来（实测），
 * 所以配置必须用 string，发消息时也一并用 CQ 码最稳。
 * @param {import('../src/message.js').Segment[]} segments
 */
export function toCqCode(segments) {
  const parts = [];
  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        if (seg.text) parts.push(escapeCq(seg.text));
        break;
      case 'at':
        parts.push(`[CQ:at,qq=${escapeCq(String(seg.id))}]`);
        break;
      case 'image': {
        const file = seg.file ?? seg.url ?? '';
        if (file) parts.push(`[CQ:image,file=${escapeCq(file)}]`);
        break;
      }
      case 'reply':
        parts.push(`[CQ:reply,id=${escapeCq(String(seg.id))}]`);
        break;
      case 'file':
        parts.push(`[CQ:file,file=${escapeCq(seg.url ?? seg.file ?? '')}]`);
        break;
      default:
        break;
    }
  }
  return parts.join('');
}

/**
 * CQ 码转义：`&` `[` `]` `,` 必须转义，否则会被当成分隔符。
 * @param {string} s
 */
function escapeCq(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/,/g, '&#44;');
}

/** 群号/QQ 号必须是数字，OneBot 端不接受字符串。 */
export function toOneBotId(id) {
  const n = Number(id);
  return Number.isSafeInteger(n) ? n : id;
}

/**
 * 找 WebSocket 实现：ws 优先（支持自定义 header），没有就退回全局 WebSocket（Node 22+ 自带）。
 *
 * 注意：ESM 下 `import('ws')` 只能解析当前包的真实依赖；插件装在 DSH profile 里时，
 * 真正能用的 ws 在宿主 node_modules。所以这里按顺序试：包内 → createRequire 解析 → 全局。
 * @returns {Promise<{ WebSocket: any, supportsHeaders: boolean }>}
 */
async function loadWebSocket() {
  // 1) 包内依赖
  try {
    const mod = await import('ws');
    const Ctor = mod.default ?? mod.WebSocket ?? mod;
    if (isUsableSocket(Ctor)) return { WebSocket: Ctor, supportsHeaders: true };
  } catch {
    /* 继续 */
  }
  // 2) 用 CJS 解析器找 ws。
  //    DSH 跑的是 Electron 的 Node 环境，DSH_HOME 不一定是环境变量，
  //    所以除了 env 和插件自身，还要沿真实路径往上找：插件目录 → plugins → .dsh → profiles/desktop。
  const { createRequire } = await import('node:module');
  const bases = [];
  try {
    // 从本文件真实位置往上爬，找到 profile 的 node_modules
    const here = fileURLToPath(import.meta.url);
    let dir = path.dirname(here);
    for (let i = 0; i < 6; i += 1) {
      bases.push(`${dir.replace(/\\/g, '/')}/`);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
      // 到 .dsh 时补上 profile 目录（ws 装在 profile 的 node_modules 里）
      if (path.basename(dir) === '.dsh') bases.push(`${dir.replace(/\\/g, '/')}/profiles/desktop/`);
    }
  } catch {
    /* 拿不到路径就跳过 */
  }
  bases.push(import.meta.url);
  if (process.env.NODE_PATH) bases.push(`${process.env.NODE_PATH.replace(/\\/g, '/')}/`);
  if (process.env.DSH_HOME) bases.push(`${process.env.DSH_HOME.replace(/\\/g, '/')}/profiles/desktop/`);

  for (const base of bases) {
    try {
      const require = createRequire(base.startsWith('file:') ? base : `file:///${base}`);
      const resolved = require.resolve('ws');
      const mod = await import(pathToFileURL(resolved).href);
      const Ctor = mod.default ?? mod.WebSocket ?? mod;
      if (isUsableSocket(Ctor)) return { WebSocket: Ctor, supportsHeaders: true };
    } catch {
      /* 换下一个 base */
    }
  }
  // 3) 运行时自带的全局 WebSocket
  if (typeof globalThis.WebSocket === 'function') {
    return { WebSocket: wrapGlobalWebSocket(globalThis.WebSocket), supportsHeaders: false };
  }
  throw new Error('缺少 WebSocket 实现：请安装 ws，或使用 Node 22+');
}

function isUsableSocket(Ctor) {
  return typeof Ctor === 'function' && typeof Ctor.prototype?.on === 'function';
}

/**
 * 把浏览器风格的全局 WebSocket 包成 ws 的用法（on/结构 + headers 不支持）。
 * 这是兜底路径：协议端 token 要自定义 header，走这里会 401。
 */
function wrapGlobalWebSocket(Ctor) {
  return class {
    static supportsHeaders = false;

    constructor(url) {
      const inner = new Ctor(url);
      this.inner = inner;
      this.readyState = 0;
      /** @type {Map<string, Function[]>} */
      this.handlers = new Map();
      inner.onopen = () => {
        this.readyState = 1;
        this.fire('open');
      };
      inner.onclose = () => {
        this.readyState = 3;
        this.fire('close');
      };
      inner.onerror = () => this.fire('error', new Error('WebSocket 错误'));
      inner.onmessage = (e) => this.fire('message', e.data);
    }
    on(event, fn) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }
    fire(event, arg) {
      for (const fn of this.handlers.get(event) ?? []) {
        try {
          fn(arg);
        } catch {
          /* 单个回调失败不影响其他 */
        }
      }
    }
    send(data) {
      this.inner.send(data);
    }
    close() {
      this.inner.close();
    }
  };
}
