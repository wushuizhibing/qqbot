/**
 * 会话路由：内部消息 → DSH 会话的落点。
 *
 * 这一层是"不要做成外挂"的关键：会话由这里给出了**唯一的、可预测的**键，
 * 将来接 DSH 会话服务时，每个 key 对应一个真实会话。
 * 现在先把 key 规则和上下文窗口定下来，跟 DSH 的对接放到 bridge 里做。
 */

/**
 * 会话键规则：
 *   group:<groupId>
 *   private:<userId>
 * 单号运行，一个群/一个人就是一个会话；不掺 selfId。
 * @param {import('./message.js').Message} msg
 */
export function sessionKeyOf(msg) {
  return msg.chatKind === 'group' ? `group:${msg.chatId}` : `private:${msg.chatId}`;
}

/**
 * 路由表：哪个会话接进哪个工作区/预设。
 * @typedef {object} RouteRule
 * @property {'group'|'private'} chatKind
 * @property {string} chatId
 * @property {string} [workspacePath]  DSH 工作区路径；缺省用默认工作区
 * @property {string} [agentPreset]   DSH 的 agent 预设
 * @property {boolean} [enabled]
 */

/**
 * @param {RouteRule[]} rules
 */
export function createRouter(rules = []) {
  const list = rules.map((r) => ({ enabled: true, ...r }));

  return {
    /** @param {import('./message.js').Message} msg */
    resolve(msg) {
      return (
        list.find(
          (r) => r.chatKind === msg.chatKind && String(r.chatId) === String(msg.chatId) && r.enabled,
        ) ?? null
      );
    },
    list() {
      return [...list];
    },
    add(rule) {
      list.push({ enabled: true, ...rule });
    },
  };
}

/**
 * 上下文窗口：每个会话只保留最近 N 条，避免上下文无限长。
 * @param {number} [size]
 */
export function createContextWindow(size = 20) {
  /** @type {Map<string, import('./message.js').Message[]>} */
  const windows = new Map();
  return {
    /** @param {string} key @param {import('./message.js').Message} msg */
    push(key, msg) {
      const list = windows.get(key) ?? [];
      list.push(msg);
      while (list.length > size) list.shift();
      windows.set(key, list);
    },
    /** @param {string} key */
    get(key) {
      return [...(windows.get(key) ?? [])];
    },
    /** @param {string} key */
    clear(key) {
      windows.delete(key);
    },
  };
}
