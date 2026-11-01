/**
 * 适配器基类：协议端翻译层的统一接口。
 *
 * 约定：
 *   - 适配器只负责"协议格式 ⇄ 内部消息结构"的翻译和收发；
 *   - 不自己建会话、不自己存记忆、不自己管人设 —— 那些归 DSH 侧；
 *   - start() 可以是异步的（拉起子进程、连 WS 都行），stop() 必须幂等。
 */

/**
 * @typedef {object} AdapterEvents
 * @property {(msg: import('./message.js').Message) => void} [onMessage]
 * @property {(info: { connected: boolean, detail?: string }) => void} [onStatus]
 * @property {(error: Error) => void} [onError]
 */

export class AdapterBase {
  /** @param {object} [options] */
  constructor(options = {}) {
    this.options = options;
    /** @type {AdapterEvents} */
    this.events = {};
    this.running = false;
  }

  /** @param {AdapterEvents} events */
  setEvents(events) {
    this.events = { ...events };
  }

  /** @param {import('./message.js').Message} msg */
  emitMessage(msg) {
    try {
      this.events.onMessage?.(msg);
    } catch (error) {
      this.emitError(error);
    }
  }

  /** @param {{connected: boolean, detail?: string}} info */
  emitStatus(info) {
    try {
      this.events.onStatus?.(info);
    } catch {
      /* 状态提示失败不算错 */
    }
  }

  /** @param {unknown} error */
  emitError(error) {
    const e = error instanceof Error ? error : new Error(String(error));
    try {
      this.events.onError?.(e);
    } catch {
      /* ignore */
    }
  }

  /** 适配器标识，用于配置和日志 */
  static get id() {
    return 'base';
  }

  /** 启动；子类实现 */
  async start() {
    throw new Error(`${this.constructor.name}.start() 未实现`);
  }

  /** 停止；子类实现，必须幂等 */
  async stop() {}

  /**
   * 发消息；子类实现。
   * @param {{ chatKind: 'group'|'private', chatId: string, segments: import('./message.js').Segment[] }} _target
   * @returns {Promise<{ messageId?: string }>}
   */
  async send(_target) {
    throw new Error(`${this.constructor.name}.send() 未实现`);
  }
}

/**
 * 适配器注册表：按 id 找到实现。
 * 新协议端只要实现 AdapterBase 并注册进来，DSH 侧不用改。
 */
export class AdapterRegistry {
  constructor() {
    /** @type {Map<string, new (options?: object) => AdapterBase>} */
    this.adapters = new Map();
  }

  /**
   * @param {string} id
   * @param {new (options?: object) => AdapterBase} ctor
   */
  register(id, ctor) {
    this.adapters.set(id, ctor);
    return this;
  }

  /** @param {string} id */
  has(id) {
    return this.adapters.has(id);
  }

  /** @param {string} id */
  list() {
    return [...this.adapters.keys()];
  }

  /**
   * @param {string} id
   * @param {object} [options]
   * @returns {AdapterBase}
   */
  create(id, options) {
    const Ctor = this.adapters.get(id);
    if (!Ctor) throw new Error(`未知适配器: ${id}（可用: ${this.list().join(', ') || '无'}）`);
    return new Ctor(options);
  }
}
