/**
 * 面板数据供给：让"别的插件"往 mood-kit 面板里加区块。
 *
 * 问题：mood-kit 是独立插件，它不知道有 QQ、微信还是别的什么在跑，
 * 更拿不到那些插件的会话列表、最近消息、可调参数。
 *
 * 解法：反向注册。聊天插件启动时调 `ctx.get('moodPanel').contribute(id, fn)`，
 * 面板渲染时就挨个问它们要数据。
 *
 *   mood-kit 面板
 *     ├─ 情绪（自己生成）
 *     ├─ 人物（自己生成）
 *     ├─ [qq] 参数调节 / 会话 / 最近消息   ← qq-kit 贡献
 *     └─ [xxx] 以后别的插件也能加
 */

/**
 * @param {{ warn?: (m: string) => void }} [options]
 */
export function createPanelHub(options = {}) {
  const warn = options.warn ?? (() => {});
  /** @type {Map<string, { data: () => any, apply?: (patch: object) => any }>} */
  const contributors = new Map();

  return {
    /**
     * 注册一个数据供给方。
     *
     * @param {string} id 唯一标识（插件名就行）
     * @param {(() => any) | { data: () => any, apply?: (patch: object) => any }} fnOrSpec
     *   传函数 = 只有数据；传对象 = 数据 + 可选的"应用参数"回调
     * @returns {() => void} 注销函数
     */
    contribute(id, fnOrSpec) {
      const key = String(id || '');
      if (!key) return () => {};
      let spec;
      if (typeof fnOrSpec === 'function') spec = { data: fnOrSpec };
      else if (fnOrSpec && typeof fnOrSpec.data === 'function') spec = fnOrSpec;
      else return () => {};
      contributors.set(key, spec);
      return () => {
        if (contributors.get(key) === spec) contributors.delete(key);
      };
    },

    /**
     * 把参数改动转给对应的供给方。
     * @param {string} id
     * @param {object} patch
     */
    apply(id, patch) {
      const spec = contributors.get(String(id || ''));
      if (!spec) throw new Error(`没有这个供给方: ${id}`);
      if (typeof spec.apply !== 'function') throw new Error(`${id} 不支持在线调参`);
      return spec.apply(patch);
    },

    /** 某个供给方是否支持调参 */
    canApply(id) {
      return typeof contributors.get(String(id || ''))?.apply === 'function';
    },

    /**
     * 收集所有供给方的数据。
     * 单个供给报错不能拖垮整个面板 —— 记一条并跳过。
     */
    collect() {
      /** @type {Record<string, any>} */
      const out = {};
      for (const [id, spec] of contributors) {
        try {
          const data = spec.data();
          if (data !== undefined && data !== null) {
            // 告诉面板"这个供给方支持在线调参"，前端据此决定要不要显示按钮
            out[id] = { ...data, _canApply: typeof spec.apply === 'function' };
          }
        } catch (error) {
          warn(`面板供给方 ${id} 出错（跳过）: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return out;
    },

    /** 已注册的供给方 id（调试用） */
    ids() {
      return [...contributors.keys()];
    },
  };
}
