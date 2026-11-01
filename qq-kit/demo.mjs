#!/usr/bin/env node
/**
 * 本地冒烟：不启动 DSH，用 mock 适配器把链路跑一遍。
 *
 * 用法：node demo.mjs
 *
 * 注意两处接口约定（都是踩过的坑）：
 *   - 配置是 apply 的**第二个参数**，不是 ctx.config
 *   - apply 不返回插件对象，调试接口挂在 ctx.qqKit 上
 */
import { apply } from './index.js';

const logs = [];
const ctx = {
  logger: {
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
    debug: () => {},
  },
  effect: () => {},
};

apply(ctx, {
  adapter: 'mock',
  // 不接 DSH：用占位子代理跑链路
  useDshAgents: false,
  dryRun: false,
  merge: { windowMs: 200, perMinute: 0 },
  routes: [{ chatKind: 'group', chatId: '123456' }],
});

const plugin = ctx.qqKit;
const adapter = plugin.adapter;

adapter.receive({ chatId: '123456', userId: '111', name: '小A', text: '在吗' });
adapter.receive({ chatId: '123456', userId: '222', name: '小B', text: '这鱼今天还活着吗' });

await new Promise((r) => setTimeout(r, 600));

console.log('--- 发送记录 ---');
console.dir(adapter.sent, { depth: 4 });
console.log('--- 日志 ---');
console.log(logs.map(([l, m]) => `${l}: ${m}`).join('\n'));
process.exit(0);
