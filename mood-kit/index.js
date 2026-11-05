/**
 * dsh-mood-kit 入口。
 *
 * 这是一个**与协议无关**的情绪/关系插件：它不连任何聊天协议端，
 * 只接收别的插件喂进来的情绪，维护状态、历史、星图，并提供面板。
 *
 * 对外能力挂在 `ctx.moodKit`：
 *   - observe({ sessionKey, mood, intensity })  记录一轮情绪
 *   - current(sessionKey)                       读当前情绪
 *   - stats(window)                             情绪分布
 *   - people({ memoryDir, chatIds })            人物关系
 *   - points() / latest()                       历史点
 *
 * 接入方式见 README。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMoodState } from './src/core.js';
import { createPanelHub } from './src/panel-hub.js';
import { snapshot as snapCode, changedSince } from './src/staleness.js';
import { renderPanelHtml, collectPanelState } from './src/panel.js';

export const name = 'mood-kit';
export const inject = [];

export const VERSION = '0.3.0';

/**
 * @param {any} ctx
 * @param {object} [bundleConfig]
 */
export function apply(ctx, bundleConfig = {}) {
  try {
    return applyInner(ctx, bundleConfig);
  } catch (error) {
    // 插件加载失败时 DSH 会静默跳过，写个固定路径的探针方便排查
    try {
      fs.appendFileSync(
        'C:\\plugins\\mood-kit-boot.log',
        JSON.stringify({
          t: new Date().toISOString(),
          event: 'apply-error',
          message: String(error?.message ?? error).slice(0, 500),
          stack: String(error?.stack ?? '').slice(0, 1500),
        }) + '\n',
      );
    } catch {
      /* ignore */
    }
    throw error;
  }
}

function applyInner(ctx, bundleConfig) {
  const config = {
    // 情绪历史落盘位置；留空 = $DSH_HOME/mood-kit-history.json
    dataFile: '',
    // 群记忆目录（人物星系的数据源）；留空则不画人物
    memoryDir: '',
    // 历史上限与保留天数
    //
    // 2026-11-05 放宽：原来 2000 条 / 7 天，等于一周前的情绪点自动就丢了。
    // 那样攒不住东西 —— 哪天想回头看"上个月什么样"，发现早没了。
    // 现在留一年、两万个点（约 40MB），基本等于不丢。
    //
    // 情绪点本身很小（一轮一条，一天最多也就几百条），不用吝啬。
    maxPoints: 20000,
    keepDays: 365,
    ...(bundleConfig ?? {}),
  };

  const log = (level, msg) => {
    try {
      ctx?.logger?.[level]?.(`[${name}] ${msg}`);
    } catch {
      /* ignore */
    }
  };

  const dataFile =
    config.dataFile || path.join(process.env.DSH_HOME ?? os.homedir(), 'mood-kit-history.json');

  const state = createMoodState({
    file: dataFile,
    memoryDir: config.memoryDir,
    max: Number(config.maxPoints) || 20000,
    keepDays: Number(config.keepDays) || 365,
    warn: (m) => log('warn', m),
  });
  log('info', `情绪中枢已启动，历史 ${state.points().length} 个点，落盘 ${dataFile}`);

  // 面板数据供给：别的插件把"会话/消息/可调参数"喂进来，面板统一渲染。
  // 这样 mood-kit 能当总面板用，而不是只管情绪。
  const panelHub = createPanelHub({ warn: (m) => log('warn', m) });

  // 启动时给代码文件拍个快照：之后如果磁盘上的文件比这份新，说明改了没重启。
  // 服务端代码是一次性加载进内存的，改了不重启跑的还是旧的。
  const bootSnapshot = snapCode();

  // 对外服务：别的插件通过 ctx.get('moodKit') 拿到它
  const api = {
    version: VERSION,
    observe: state.observe,
    current: state.current,
    stats: state.stats,
    people: state.people,
    points: state.points,
    latest: state.latest,
    /**
     * 注册"关系判定器"：聊天插件把自己的 relationshipOf 交过来，面板就用它。
     *
     * 为什么要有这个：判定逻辑原来两边各写一份，然后分叉了 ——
     * qq-kit 补了防冒充的坑，面板这边还是老版本，把"爱出题让人写主人"
     * 这种条目也判成主人。让聊天插件当唯一权威，就不会再对不上。
     *
     * @param {(memory: string, userId: string) => string} fn
     */
    setRelationshipJudge(fn) {
      if (typeof fn === 'function') options.relationshipOf = fn;
    },
    /** 面板供给：聊天插件把会话/消息/参数注册进来 */
    panel: {
      contribute: (id, fn) => panelHub.contribute(id, fn),
      apply: (id, patch) => panelHub.apply(id, patch),
      ids: () => panelHub.ids(),
    },
    get history() {
      return state.history;
    },
    classes: state.classes,
  };

  // 用 cordis 的服务机制暴露给别的插件：
  //   provide 声明服务（owner 是本 fiber），赋值 = 注册实现；
  //   别的插件用 ctx.get('moodKit') 就能拿到（拿不到返回 undefined，不抛）。
  // ⚠️ 直接 `ctx.moodKit = api` 会抛 `cannot set property "moodKit" without provide`。
  try {
    if (typeof ctx.provide === 'function') {
      ctx.provide('moodKit');
      ctx.moodKit = api;
    } else {
      // 极端情况下（老版本 cordis）退回直接挂，至少不崩
      ctx.moodKit = api;
    }
  } catch (error) {
    log('warn', `暴露 ctx.moodKit 失败（qq-kit 会用内置降级）: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 面板：/mood-kit 页面 + /mood-kit/api/state
  try {
    ctx.inject(['webServer'], (child) => {
      const disposers = [];
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: '/mood-kit',
          handler: (_req, res) => {
            const html = Buffer.from(renderPanelHtml(), 'utf8');
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Length': html.length,
              'Cache-Control': 'no-store',
            });
            res.end(html);
          },
        }),
      );
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: '/mood-kit/api/state',
          handler: (_req, res) => {
            const payload = JSON.stringify(
              collectPanelState({
                state,
                memoryDir: config.memoryDir,
                version: VERSION,
                // 别的插件（qq-kit 等）贡献的区块：会话、消息、可调参数
                contributions: panelHub.collect(),
                // 改了源码但没重启时，面板顶部会提示（否则很容易误判成"有 bug"）
                stale: changedSince(bootSnapshot),
              }),
            );
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': Buffer.byteLength(payload),
              'Cache-Control': 'no-store',
            });
            res.end(payload);
          },
        }),
      );
      // 调参接口：面板上改参数，转给对应供给方（qq-kit 等）去落地
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: '/mood-kit/api/tune',
          handler: (req, res) => {
            const send = (code, obj) => {
              const body = JSON.stringify(obj);
              res.writeHead(code, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
                'Cache-Control': 'no-store',
              });
              res.end(body);
            };
            if (req.method !== 'POST') return send(405, { error: 'POST only' });
            let raw = '';
            req.on('data', (chunk) => {
              raw += chunk;
              if (raw.length > 64 * 1024) req.destroy();
            });
            req.on('end', () => {
              try {
                const body = JSON.parse(raw || '{}');
                const id = String(body.id ?? '');
                if (!id) return send(400, { ok: false, error: '缺少 id' });
                const result = panelHub.apply(id, body.patch ?? {});
                log('info', `面板调参 ${id}: ${JSON.stringify(body.patch).slice(0, 200)}`);
                send(200, { ok: true, result });
              } catch (error) {
                send(400, { ok: false, error: error instanceof Error ? error.message : String(error) });
              }
            });
          },
        }),
      );
      log('info', '面板已挂到 /mood-kit');
      ctx?.effect?.(() => () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose();
          } catch {
            /* ignore */
          }
        }
      }, `${name}.panel`);
    });
  } catch (error) {
    log('warn', `挂面板失败（不影响情绪功能）: ${error instanceof Error ? error.message : String(error)}`);
  }

  ctx?.effect?.(() => () => {
    try {
      state.save();
    } catch {
      /* ignore */
    }
    // 服务由 provide 的 effect 自动注销，这里只落盘
  }, `${name}.lifecycle`);
}
