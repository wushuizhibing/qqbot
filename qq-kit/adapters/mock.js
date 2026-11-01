/**
 * 内置 mock 适配器：不连任何协议端，用来跑通链路和写测试。
 * 它把"外部来的消息"从内存队列喂进来，send() 记录下来。
 */
import { AdapterBase } from '../src/adapter.js';
import { makeMessage, toSegments } from '../src/message.js';

export class MockAdapter extends AdapterBase {
  static get id() {
    return 'mock';
  }

  constructor(options = {}) {
    super(options);
    /** @type {any[]} */
    this.sent = [];
    this.queue = [];
  }

  async start() {
    this.running = true;
    this.emitStatus({ connected: true });
  }

  async stop() {
    this.running = false;
  }

  /**
   * 测试用：模拟收到一条消息。
   * @param {{chatKind?: 'group'|'private', chatId: string|number, userId: string|number, name?: string, text?: string, segments?: any[]}} input
   */
  receive(input) {
    const msg = makeMessage({
      chatKind: input.chatKind ?? 'group',
      chatId: String(input.chatId),
      sender: { id: String(input.userId), name: input.name },
      segments: input.segments ?? toSegments([{ type: 'text', data: { text: input.text ?? '' } }]),
    });
    this.queue.push(msg);
    this.emitMessage(msg);
    return msg;
  }

  async send(target) {
    const record = {
      chatKind: target.chatKind,
      chatId: target.chatId,
      segments: target.segments,
    };
    this.sent.push(record);
    return { messageId: `mock-${this.sent.length}` };
  }
}
