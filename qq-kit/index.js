/**
 * dsh-qq-kit 入口。
 *
 * 链路：适配器 → 合并 → 路由 → 两段式桥接（总结子代理 → 思考子代理）→ 执行侧发送。
 *
 * 内核不绑定任何具体协议端：适配器只是翻译层，见 docs/writing-adapters.md。
 * 内置 `mock`（离线跑通链路）和 `onebot`（OneBot v11 公开协议，通用实现）。
 */
import { AdapterRegistry } from './src/adapter.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createTrace } from './src/trace.js';
import { createHistoryLog } from './src/history.js';
import { createMemeLibrary } from './src/meme.js';
import { loadPersona } from './src/persona.js';
import { findSoulFile, describeSoulLocations } from './src/soul-finder.js';
import { pickPeopleToUpdate, parsePeopleSection, mergeImpressions, writeMemoryFile, hasPersonEntry, addPersonEntry } from './src/impressions.js';
import { createImpressionDistiller } from './src/impression-distill.js';
import { diaryPath, parseDiary, renderDiary, mergeDiary, writeDiaryFile, pickPeopleForDiary } from './src/diary.js';
import { createDiaryDistiller } from './src/diary-distill.js';
import { renameInMemory, writeMemorySafely, RENAME_CHECK_MS } from './src/rename.js';
import { findNotable, findNotableByGroup, observeState } from './src/state-observe.js';
import { findArchivable, archiveSessions } from './src/archive.js';
import { snapshot as snapCode, changedSince } from './src/staleness.js';
import { renderDiaryHtml, listDiaryPeople, readDiary } from './src/diary-panel.js';
import { loadGroupMemory, loadKnownUsers, renderMemoryBlock, trimGroupMemory, relationshipOf, relationshipHint, impersonationGuard } from './src/memory.js';
import { createStore } from './src/storage.js';
import { createLiveConfig } from './src/live-config.js';
import { createBuiltinMood } from './src/mood-builtin.js';
import { createUsageWatch } from './src/usage-watch.js';
import { collectState, renderPanelHtml } from './src/panel.js';
import { toPlainText, isMention } from './src/message.js';
import { createContextWindow, createRouter, sessionKeyOf } from './src/session.js';
import { createMerger } from './src/merge.js';
import {
  createStubSummarizer,
  createStubThinker,
  createAdapterSender,
  createTwoStageBridge,
  renderMessages,
} from './src/bridge.js';
import { carryMood } from './src/emotion.js';
import { loadImagesFromMessages } from './src/image.js';
import { loadFramesFromMessages } from './src/video.js';
import {
  createDshAgents,
  createLlmSummarizer,
  createLlmThinker,
} from './src/dsh-agents.js';
import { MockAdapter } from './adapters/mock.js';
import { SnowLumaAdapter } from './adapters/snowluma.js';
import { OneBotAdapter } from './adapters/onebot.js';

export const name = 'qq-kit';

/**
 * 不 inject 任何服务：插件只做收发和本地计算，DSH 侧的服务用 ctx.get() 按需取。
 *
 * 注意两件事（踩过的坑）：
 *   1. 配置是 apply 的**第二个参数** `bundleConfig`，不是 `ctx.config`；
 *      cordis 的 Context 是 Proxy，读未 inject 声明的属性会直接抛
 *      `cannot get property "config" without inject`，插件在加载阶段就崩、宿主静默跳过。
 *   2. apply 的返回值必须为空：cordis 会把返回值当 effect，非函数即 Invalid effect。
 */
export const inject = [];

export const VERSION = '0.4.0';

export function apply(ctx, bundleConfig = {}) {
  // 最外层兜底：apply 抛错时 DSH 会静默跳过整个插件，什么都看不到。
  // 这里把任何异常都写进固定路径的 boot 日志，方便排查。
  try {
    return applyInner(ctx, bundleConfig);
  } catch (error) {
    const probe = createTrace('D:\\dsh\\qq-kit-boot.log');
    probe.write('apply-error', {
      message: String(error?.message ?? error).slice(0, 500),
      stack: String(error?.stack ?? '').slice(0, 2000),
      dshHome: process.env.DSH_HOME ?? '(unset)',
    });
    probe.close();
    throw error;
  }
}

function applyInner(ctx, bundleConfig) {
  // 启动时给源码拍个快照。之后面板每次请求都会比对：
  // 磁盘上的文件比这个新，就说明改了代码没重启 —— 面板顶部会顶一条黄条出来。
  // 不这么做的话，改完不重启跑的还是旧代码，而界面看起来一切正常，
  // 特别容易把"没生效"误判成"有 bug"。
  const bootSnapshot = snapCode();

  const config = {
    adapter: 'mock',
    merge: { windowMs: 2000, maxMessages: 20, maxWaitMs: 8000 },
    routes: [],
    // 默认接 DSH 子代理；设成 false 退回占位实现（离线/测试用）
    useDshAgents: true,
    agentOptions: {},
    // 只观察：子代理跑完只打印计划，不往群里发
    dryRun: false,
    // 人格：soul.md 路径与档位（core = 关键几节，full = 全文）。
    //
    // 留空 = **自动查找**：cwd/soul.md、cwd/persona/soul.md、<DSH_HOME>/soul.md 等。
    // 把灵魂文件往那几个位置一放就能直接用，不用改配置。
    // 显式写路径 = 只认那个；写 false = 明确不要，用兜底人格。
    personaPath: '',
    personaMode: 'core',
    // 记忆：群档案目录 + 认人表 + 摘要持久化文件
    memoryDir: '',
    knownUsersPath: '',
    // 摘要持久化文件；留空 = 用 DSH_HOME 下的 qq-kit-summaries.json
    summaryFile: '',
    // 记住的人里，非当前说话人的最多补几条（0 = 只带当前说话的人，最省）
    memoryMaxOthers: 0,
    // 群友印象自动更新：定时从聊天流水里提炼"这些人现在什么样"，合并进群记忆。
    // 设 false 关闭；其余字段都有默认值。
    impressions: {
      enabled: true,
      // 新人第一次说话就建档（不等 6 小时批量更新）
      autoAddPeople: true,
      // 群友改名后自动更新记忆里的名字（按 QQ 号认人，名字只是显示用）
      syncRename: true,
      // 多久跑一次（默认 6 小时：够久能看出变化，又不至于每次都调模型）
      intervalMs: 6 * 60 * 60 * 1000,
      // 看多久以内的流水
      lookbackMs: 24 * 60 * 60 * 1000,
      // 一次更新几个人
      maxPeople: 6,
    },
    // 个人日记：把关键事件按人归档（要求 / 冲突 / 承诺 / 重要信息），纯闲聊不记。
    // 跟印象分工不同：印象进 prompt（短），日记只给人看（具体、带时间）。
    // 设 false 关闭；dir 留空 = memoryDir 旁边的 qq-diary。
    diary: {
      enabled: true,
      dir: '',
      // 多久跑一次（默认 6 小时，跟印象一起）
      intervalMs: 6 * 60 * 60 * 1000,
      // 看多久以内的流水
      lookbackMs: 24 * 60 * 60 * 1000,
      // 一次最多处理几个人
      maxPeople: 8,
    },
    // 状态观察：从流水里看作息/活跃度/语言的变化。
    //
    // ⚠️ 这些数据**只在后台算，不往面板上放，也不拿去跟当事人互动**。
    //
    // 2026-11-05 定下的：被人从聊天记录里算出来"状态不好"，
    // 然后由机器人决定要不要去关心 —— 那不是关心，是居高临下。
    // 真关心在当场那句接话里，不从数据推。详见 src/state-observe.js 文件头。
    //
    // 现在保留计算是为了以后能「汇报」：需要时调 api.stateWatch 拿数据，
    // 但不会自动显示、不会自动发消息。
    stateWatch: {
      enabled: true,
      // 一次最多返回几个人（0 = 不限）。只在主动索取时影响结果条数。
      limit: 0,
    },
    // 会话归档：把堆着的 QQ 空壳会话挪到备份目录。
    //
    // 为什么需要：qq-kit 每轮对话都让 DSH 建一个 agent 会话，
    // 跑几天就是几千个，左侧栏全是看不出区别的"新会话"。
    //
    // 已经确认这些会话文件里**只有元信息、没有对话内容**（正文在 history-*.jsonl），
    // 所以挪走是零损失的 —— 而且只挪，不删，随时能挪回来。
    archive: {
      enabled: true,
      // 多久没动才算旧
      keepDays: 7,
      // 每 6 小时检查一次（归档不是急事，没必要更频繁）
      intervalMs: 6 * 60 * 60 * 1000,
      // 只归档空壳。有对话内容的会话哪怕过期了也留着 —— 那种删了补不回来。
      onlyEmpty: true,
    },
    // 每几轮真跑一次总结（其余轮次复用上一轮摘要，省一次模型调用）
    summarizeEvery: 3,
    // 情绪历史保留量：条数上限 + 天数上限，两头都封住；超了自动丢最早的那批
    moodHistoryMax: 2000,
    moodKeepDays: 7,
    // 冷场判定：距这个会话上一条消息超过这么久，本条立刻触发思考（不等窗口）
    coldSilenceMs: 60000,
    // 被 @ 的消息必须马上处理，不受每分钟限流压制
    // selfId 是机器人自己的 QQ 号（配了才认得出 @我；@全体成员一律算）
    selfId: '',
    // 主人的 QQ 号。填上之后，只有这个号能被认作主人。
    //
    // 留空 = 只按群记忆判（记忆里写了谁是主人）。
    // 建议填：记忆文件是模型自动维护的，可能写错；写死的号不会。
    ownerId: '',
    atUrgent: true,
    // 识图：图片下载转多模态输入。设 false 关闭。
    vision: { maxImages: 3, maxBytes: 4 * 1024 * 1024 },
    // 表情包图库根目录（每个子目录是一个分类，里面放 jpg/png/gif/webp）。
    // 留空 = 没有表情包能力；图库由使用者自己放，不随插件分发。
    memeRoots: [],
    // 视频抽帧：给了 ffmpeg 路径才启用（没装就当没视频）
    // 形如 { ffmpeg: 'C:/path/ffmpeg.exe', frames: 3, maxVideos: 1 }
    videoFrames: null,
    // 别人的号被 @ 时，硬触发一次提醒（不依赖模型记性）
    // 形如 { ids: ['123456789'], text: '主人 @ 你了' }
    notifyOnMention: null,
    // 今日花费到阈值时私聊通知（单位跟鲸鱼小组件一致，人民币元）
    // 形如 { threshold: 25, target: 'private:123456789', text: '...', intervalMs: 60000 }
    notifyUsage: null,
    ...(bundleConfig ?? {}),
  };

  // ── 运行时配置：不重启也能调 ──
  // base 来自 cordis.patch.yml；覆写来自 qq-kit-live.json（改了自动生效）。
  // 代码里读配置一律走 live()，不要在启动时把值捕获进局部变量。
  const liveFile =
    config.liveConfigFile === false
      ? ''
      : (config.liveConfigFile || path.join(process.env.DSH_HOME ?? os.homedir(), 'qq-kit-live.json'));
  const live = createLiveConfig({
    base: config,
    file: liveFile,
    warn: (m) => {
      try {
        ctx?.logger?.warn?.(`[${name}] ${m}`);
      } catch {
        /* ignore */
      }
    },
    onChange: (next) => {
      // 合并节奏可以热改
      if (typeof merger?.setOptions === 'function') merger.setOptions(next.merge ?? {});
    },
  });
  live.start();
  /** 当前生效的配置（每次调用拿最新） */
  const cfg = () => live.current();

  const registry = new AdapterRegistry()
    .register('mock', MockAdapter)
    .register('snowluma', SnowLumaAdapter)
    .register('onebot', OneBotAdapter);
  // 需要盯的"别人的号"：被 @ 时要喊一声
  const watchedIds = new Set((config.notifyOnMention?.ids ?? []).map(String));
  const mentionOfWatched = (msg) => {
    if (watchedIds.size === 0) return false;
    return (msg?.segments ?? []).some((s) => s.type === 'at' && watchedIds.has(String(s.id ?? '')));
  };
  const merger = createMerger({
    ...cfg().merge,
    isUrgent: (msg) =>
      (cfg().atUrgent ? isMention(msg, { selfId: cfg().selfId || config.adapterOptions?.selfId }) : false) ||
      mentionOfWatched(msg),
  });
  const router = createRouter(config.routes ?? []);
  const window = createContextWindow(20);

  // 历史日志：按天切文件，记"谁说了什么、回了什么"，给复盘用。
  // 默认 $DSH_HOME/qq-kit-history/history-YYYY-MM-DD.jsonl
  const historyDir =
    config.historyDir === false
      ? ''
      : (config.historyDir || path.join(process.env.DSH_HOME ?? os.homedir(), 'qq-kit-history'));
  const historyLog = createHistoryLog({
    dir: historyDir,
    keepDays: Number(config.historyKeepDays) || 30,
    maxBytesPerDay: Number(config.historyMaxBytes) || undefined,
    warn: (m) => {
      try {
        ctx?.logger?.warn?.(`[${name}] ${m}`);
      } catch {
        /* ignore */
      }
    },
  });
  if (historyDir) historyLog.write('plugin/ready', { dir: historyDir });
  // 本地调试日志（默认写到 DSH_HOME/qq-kit-trace.log；串设为空则关闭）
  const trace = createTrace(
    config.traceFile === false
      ? ''
      : (config.traceFile ?? path.join(process.env.DSH_HOME ?? os.homedir(), 'qq-kit-trace.log')),
  );
  // 启动探针：写死绝对路径，不依赖任何环境变量，用来确认插件到底有没有被加载
  const probe = createTrace('D:\\dsh\\qq-kit-boot.log');
  probe.write('boot', {
    version: VERSION,
    dshHome: process.env.DSH_HOME ?? '(unset)',
    cwd: process.cwd(),
    pid: process.pid,
    adapter: config.adapter,
    dryRun: config.dryRun,
    routes: config.routes,
  });

  const log = (level, message) => {
    try {
      ctx?.logger?.[level]?.(`[${name}] ${message}`);
    } catch {
      /* 日志不该成为失败原因 */
    }
    trace.write(`log/${level}`, String(message).slice(0, 800));
  };

  // 人格：soul.md 是灵魂，思考子代理每轮都带（core 档，约 7KB）。
  //
  // 自动发现：personaPath 留空时按约定位置找（cwd/soul.md、cwd/persona/soul.md…），
  // 把文件往那一放就能用，不用改配置。显式写了路径就只认那个。
  //
  // 热更新：盯住文件的 mtime，改完**下一条消息就用新人格**，不用重启 DSH。
  // （人格是最常改的东西，改一句就要重启一次太难受。）
  const soulFile = findSoulFile({
    explicit: config.personaPath,
    warn: (m) => log('warn', m),
  });
  if (soulFile) log('info', `灵魂文件：${soulFile.path}（来自 ${soulFile.source}）`);
  else log('info', `没找到灵魂文件，用内置人格。${describeSoulLocations()}`);

  /** @type {{ text: string, source: string, mode: string, bytes: number, mtime: number }} */
  let persona = loadPersonaWithMtime(soulFile?.path, config.personaMode);
  log('info', `人格：${persona.source}（${persona.mode}，${persona.bytes} 字节）`);

  /**
   * 加载人格并带上 mtime，供热更新比对。
   * @param {string|undefined} file
   * @param {string} mode
   */
  function loadPersonaWithMtime(file, mode) {
    const loaded = loadPersona({
      path: file,
      mode: mode === 'full' ? 'full' : 'core',
      warn: (m) => log('warn', m),
    });
    let mtime = 0;
    if (file) {
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        mtime = 0;
      }
    }
    return { ...loaded, mtime };
  }

  /**
   * 人格热更新：每条消息处理前调一次（只是 statSync，很便宜）。
   * 文件变了才重新读并解析。
   */
  function refreshPersona() {
    if (!soulFile?.path) return;
    try {
      const mtime = fs.statSync(soulFile.path).mtimeMs;
      if (mtime === persona.mtime) return;
      const next = loadPersonaWithMtime(soulFile.path, cfg().personaMode);
      persona = next;
      log('info', `灵魂文件已重新加载：${persona.bytes} 字节`);
    } catch {
      /* 文件被删/改到一半，保持旧的不动 */
    }
  }

  // 两个子代理：优先用 config 注入的实现，其次接 DSH 子代理，最后退回占位。
  //
  // 时序坑：ctx.inject 的回调是**异步**的，所以这里不能先按当时的 agents 定死
  // summarizer/thinker —— 用了代理对象，每次调用时再决定走真子代理还是占位。
  /** @type {null | { runOnce: (name: string, prompt: string, t?: number) => Promise<string> }} */
  let agents = null;
  const fallbackSummarizer = createStubSummarizer();
  const fallbackThinker = createStubThinker();
  // renderMessages 的包装：把 selfId 带进去，@我 才能单独标出来。
  //
  // 直接传函数的话 dsh-agents 那边拿不到配置，@ 段只能渲染成裸号和名字，
  // 分不出"@ 我"和"@ 别人" —— 而这正好是判断"这句话冲谁来的"的关键。
  const renderMessagesWithSelf = (messages, context) =>
    renderMessages(messages, context, {
      selfId: cfg().selfId || config.adapterOptions?.selfId || '',
    });

  const llmSummarizer = createLlmSummarizer(
    {
      get agents() {
        return agents;
      },
      // 探针回调：把模型原始情绪和"是否判定为照抄"写进 trace，排查情绪卡死用
      trace: (event, data) => trace.write(event, data),
    },
    { renderMessages: renderMessagesWithSelf },
  );

  // 记忆：思考子代理每轮都带「这个群的档案 + 认识的人」，按会话键取，不跨群串。
  const knownUsers = loadKnownUsers({ path: config.knownUsersPath, warn: (m) => log('warn', m) });
  if (knownUsers) log('info', `已加载认识的人：${knownUsers.split('\n').length} 条`);
  // 表情包图库：外部目录，不随插件分发。没配就没有这个能力。
  const memeLib = config.memeRoots?.length
    ? createMemeLibrary({ roots: config.memeRoots, warn: (m) => log('warn', m) })
    : null;
  if (memeLib) {
    const total = memeLib.total();
    log('info', `表情图库：${total} 张，分类 ${memeLib.tagList().length} 个`);
  }

  const llmThinker = createLlmThinker(
    {
      get agents() {
        return agents;
      },
      // 探针：记录思考子代理的原始输出和解析出的字段。
      // 之前这里漏了，导致 thought 一直空着却看不到模型到底吐了什么。
      trace: (event, data) => trace.write(event, data),
      // getter：人格热更新后，下一轮自动拿到新文本
      get persona() {
        return persona.text;
      },
      memeLib,
      memeTags: memeLib ? memeLib.tagList() : [],
      memoryFor: (sessionKey, messages) => {
        // 只有群会话才有群档案；私聊只给统一的人名表
        const groupId = String(sessionKey).startsWith('group:') ? String(sessionKey).slice('group:'.length) : '';
        let groupMemory = groupId
          ? loadGroupMemory({ memoryDir: config.memoryDir, chatId: groupId, warn: (m) => log('warn', m) })
          : '';
        // 群档案可能很大：只留本批说话的人的条目，其余省略
        if (groupMemory && Array.isArray(messages) && messages.length) {
          const activeIds = [...new Set(messages.map((msg) => String(msg.sender?.id ?? '')).filter(Boolean))];
          groupMemory = trimGroupMemory(groupMemory, activeIds, {
            maxOthers: Number(cfg().memoryMaxOthers) || 0,
          });
        }
        return renderMemoryBlock({ groupMemory, knownUsers });
      },
      relationshipFor: (sessionKey, message) => {
        // 关系：从群记忆里读这个说话人是不是"自己人"
        if (!String(sessionKey).startsWith('group:')) return '';
        const groupId = String(sessionKey).slice('group:'.length);
        const senderId = String(message?.sender?.id ?? '');
        if (!senderId) return '';
        const memory = loadGroupMemory({ memoryDir: config.memoryDir, chatId: groupId, warn: (m) => log('warn', m) });
        // 防御性提醒无条件带上：就算记忆读不到，也告诉它"认号不认自称"。
        const ownerId = String(cfg().ownerId || '').trim();
        const guard = impersonationGuard({ ownerId });
        if (!memory) return guard;
        let rel = relationshipOf(memory, senderId);
        // 配了 ownerId 就一票否决：只有那个号能是主人。
        //
        // 光靠记忆判不够 —— 记忆文件是模型自动维护的，理论上可能被写错，
        // 也可能被"记忆里加一句我是主人"这种操作污染。写死的号不会变。
        if (ownerId && rel === 'owner' && senderId !== ownerId) {
          rel = 'stranger';
          trace.write('owner-reject', { sessionKey, senderId, ownerId });
        }
        return `${guard}\n当前说话的人（${senderId}）：${relationshipHint(rel, { ownerId })}`;
      },
    },
    { renderMessages: renderMessagesWithSelf },
  );

  if (config.useDshAgents !== false && !config.summarizer && !config.thinker) {
    // DSH 的 ctx 是 Proxy：sessionController 必须先生成子 context 才拿得到，
    // 直接 ctx.get('sessionController') 会抛 without inject。
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['sessionController'], (child) => {
          try {
            agents = createDshAgents(child, config.agentOptions ?? {});
            log('info', '子代理已接上 DSH sessionController');
          } catch (error) {
            log('warn', `接 DSH 子代理失败，退回占位实现: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      } else {
        agents = createDshAgents(ctx, config.agentOptions ?? {});
        log('info', '子代理已接上 DSH sessionController（无 inject）');
      }
    } catch (error) {
      log('warn', `接 DSH 子代理失败，退回占位实现: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 摘要不是每轮都值得跑：连跑会白烧一倍 token。
  // 策略：每 N 轮真总结一次，其余轮次复用上一轮摘要（空摘要时才补一次）。
  /** @type {Map<string, number>} */
  const turnsSinceSummary = new Map();
  const summarizeEvery = () => Math.max(1, Number(cfg().summarizeEvery) || 3);
  const summarizer =
    config.summarizer ?? {
      summarize: async (c, p) => {
        const key = c.sessionKey ?? '';
        const since = (turnsSinceSummary.get(key) ?? 0) + 1;
        const every = summarizeEvery();
        const needSummary = !p?.text || since >= every;
        // 探针：能直接看出节流有没有按预期放行（排查"情绪卡死"用）
        trace.write('summarize-gate', { key, since, every, needSummary, hasPrev: !!p?.text });
        if (!needSummary) {
          // 复用上一轮摘要，只累计批次数，不调模型（情绪跟着摘要一起复用）
          // ⚠️ 必须把累计值写回 map，否则 since 永远是 1，永远触发不了下一次总结
          turnsSinceSummary.set(key, since);
          return { ...p, covered: c.window?.length ?? p?.covered ?? 0 };
        }
        turnsSinceSummary.set(key, 0);
        const next = await (agents ? llmSummarizer.summarize(c, p) : fallbackSummarizer.summarize(c, p));
        // 情绪状态机交给外层（见下面的 moodBridge / mood-kit）：这里只产出原始情绪，
        // 不做沿用/衰减 —— 那些统一由 mood-kit 处理，别的插件接进来也是同一套行为。
        return next;
      },
    };
  const thinker =
    config.thinker ?? {
      think: (c, s) => (agents ? llmThinker.think(c, s) : fallbackThinker.think(c, s)),
    };
  // 摘要存储：跨重启保留每群上下文
  /** @type {Map<string, any>} */
  const summaries = new Map();
  const summaryFile =
    config.summaryFile ||
    path.join(process.env.DSH_HOME ?? os.homedir(), 'qq-kit-summaries.json');
  const store = createStore({ file: summaryFile, warn: (m) => log('warn', m) });
  log('info', `摘要存储：${summaryFile}`);

  let adapter = registry.create(config.adapter, config.adapterOptions ?? {});
  /** 执行侧：单号运行，直接调适配器 */
  let sender = createAdapterSender(adapter);

  // 节流（summarizeEvery）在 summarizer 包装器里做，这里不再传 —— 两处都做会相乘
  const bridge = createTwoStageBridge({ summarizer, thinker, window });

  // ── 群友印象自动更新 ──
  //
  // 群记忆里「群里的人」那一段本来是手写的，写完就烂在那儿：新人进不来、老人脾气变了也不更新。
  // 这里定时从最近的聊天流水里提炼"这些人现在什么样"，合并进记忆文件。
  //
  // 安全边界：
  //   - 只动「群里的人」段（impressions.js 的 locatePeopleSection 守着）
  //   - 写前备份到 .impressions-backup/
  //   - 原子写（临时文件 + rename）
  //   - 失败只记日志，不影响收发
  const distiller = createImpressionDistiller(
    { get agents() { return agents; }, trace: (e, d) => trace.write(e, d) },
    {},
  );

  // 日记提炼器：跟印象同一个子代理通道，但问的是"发生过什么"而不是"是什么样"。
  const diaryDistiller = createDiaryDistiller(
    { get agents() { return agents; }, trace: (e, d) => trace.write(e, d) },
    {},
  );

  /** 上次更新印象的时间（每个群一个） */
  /** @type {Map<string, number>} */
  const lastImpressionAt = new Map();

  /**
   * 更新一个群的群友印象。
   * @param {string} groupId
   * @returns {Promise<{ updated: number, reason?: string }>}
   */
  async function refreshImpressions(groupId) {
    const ic = cfg().impressions;
    if (ic === false || ic?.enabled === false) return { updated: 0, reason: 'disabled' };
    if (!config.memoryDir) return { updated: 0, reason: 'no memoryDir' };
    if (!agents) return { updated: 0, reason: 'agents not ready' };

    const everyMs = Number(ic?.intervalMs) || 6 * 60 * 60 * 1000; // 默认 6 小时
    const now = Date.now();
    const last = lastImpressionAt.get(groupId) ?? 0;
    if (now - last < everyMs) return { updated: 0, reason: 'too soon' };

    const file = path.join(config.memoryDir, `${groupId}.md`);
    let memory = '';
    try {
      memory = fs.readFileSync(file, 'utf8');
    } catch {
      return { updated: 0, reason: 'no memory file' };
    }

    // 从历史流水挑最近说话最多的人
    const since = now - (Number(ic?.lookbackMs) || 24 * 60 * 60 * 1000);
    const records = history.filter((h) => h.key === `group:${groupId}` && h.time >= since && h.text);
    const picked = pickPeopleToUpdate(
      // 跟日记那边同一个坑：senderId 要用发送者的号，不是消息 id。
      // 老流水没有 senderId（那版只存了名字），退回用名字当键 —— 不精确但总比丢掉强。
      records.map((h) => ({
        sender: h.sender,
        senderId: h.senderId || `name:${h.sender}`,
        text: h.text,
        time: h.time,
      })),
      Number(ic?.maxPeople) || 6,
    );
    if (picked.length === 0) return { updated: 0, reason: 'no messages' };

    const people = await distiller.distill({
      names: picked.map((p) => p.name),
      records,
      currentMemory: parsePeopleSection(memory)
        .map((e) => `- ${e.name}：${e.raw.replace(/^\s*[-*]\s+\*\*.*?\*\*[：:]\s*/, '')}`)
        .join('\n'),
    });
    if (people.length === 0) {
      lastImpressionAt.set(groupId, now);
      return { updated: 0, reason: 'model gave nothing' };
    }

    // 补上 QQ 号：模型只给名字，号从我们挑出来的人里对
    const withIds = people.map((p) => {
      const hit = picked.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
      return { ...p, id: hit?.id ?? '' };
    });

    const merged = mergeImpressions(memory, withIds);
    if (merged === memory) {
      lastImpressionAt.set(groupId, now);
      return { updated: 0, reason: 'no change' };
    }
    const { backup } = writeMemoryFile(file, merged);
    lastImpressionAt.set(groupId, now);
    log('info', `群友印象已更新（${groupId}）：${withIds.map((p) => p.name).join('、')}｜备份 ${path.basename(backup)}`);
    historyLog.write('impressions', {
      key: `group:${groupId}`,
      updated: withIds.map((p) => ({ name: p.name, impression: p.impression })),
    });
    return { updated: withIds.length };
  }

  // ── 个人日记 ──────────────────────────────────────────
  //
  // 跟印象分工不同：
  //   印象 —— 这个人是什么样（短，长期稳定，进 prompt）
  //   日记 —— 这个人身上发生过什么（具体，按时间排，只给人看）
  //
  // 只记关键事件（要求、冲突、承诺、重要信息），纯闲聊不记。
  // 成本：跟印象一起 6 小时跑一次，一次最多 8 个人。

  /** @type {Map<string, number>} groupId → 上次更新时间 */
  const lastDiaryAt = new Map();

  /**
   * 从群记忆里取"这个群都有谁"，给日记面板补全用。
   *
   * 为什么需要：日记是按需生成的（说过关键事件才有文件），
   * 光看日记目录只能看到零星几个人，看起来像漏了一大半。
   * 名单从记忆里来，按 QQ 号对上，没日记的人也能列出来。
   *
   * @param {string} groupId
   * @returns {Array<{ id: string, name: string }>}
   */
  function memoryRoster(groupId) {
    if (!config.memoryDir) return [];
    try {
      const memory = loadGroupMemory({
        memoryDir: config.memoryDir,
        chatId: String(groupId),
        warn: () => {},
      });
      if (!memory) return [];
      return parsePeopleSection(memory)
        .filter((p) => p.id) // 没号的没法建档，跳过
        .map((p) => ({ id: String(p.id), name: String(p.name || p.id) }));
    } catch {
      return [];
    }
  }

  /**
   * 给一个群更新群友日记。
   * @param {string} groupId
   */
  async function refreshDiaries(groupId) {
    const dc = cfg().diary;
    if (dc === false || dc?.enabled === false) return { written: 0, reason: 'disabled' };
    const root = dc?.dir || (config.memoryDir
      ? path.join(path.dirname(config.memoryDir), 'qq-diary')
      : '');
    if (!root) return { written: 0, reason: 'no diaryDir' };
    if (!agents) return { written: 0, reason: 'agents not ready' };

    const everyMs = Number(dc?.intervalMs) || 6 * 60 * 60 * 1000;
    const now = Date.now();
    if (now - (lastDiaryAt.get(groupId) ?? 0) < everyMs) return { written: 0, reason: 'too soon' };

    const since = now - (Number(dc?.lookbackMs) || 24 * 60 * 60 * 1000);
    const records = history.filter((h) => h.key === `group:${groupId}` && h.time >= since && h.text);
    const picked = pickPeopleForDiary(
      // 这里要用 **发送者的号**，不能用消息 id。
      //
      // 踩过的坑：原来写的是 `id: h.id`，那是消息 ID —— 每条都不一样，
      // 于是"按人聚合"完全失效，8 个名额被同一个人（的 8 条消息）占满，
      // 一批只能覆盖两三个人。h.senderId 才是发送者的 QQ 号。
      records.map((h) => ({ id: h.senderId || `name:${h.sender}`, name: h.sender })),
      Number(dc?.maxPeople) || 8,
    );
    if (picked.length === 0) return { written: 0, reason: 'no messages' };

    const events = await diaryDistiller.distill({
      names: picked.map((p) => p.name),
      records: records.map((h) => ({ sender: h.sender, text: h.text, time: h.time })),
    });
    if (events.length === 0) {
      lastDiaryAt.set(groupId, now);
      return { written: 0, reason: 'nothing key' };
    }

    // 按名字回落到人（模型只给名字，号从我们挑的人里对）
    let written = 0;
    for (const ev of events) {
      const who = picked.find((p) => p.name.toLowerCase() === ev.name.toLowerCase());
      if (!who) continue;
      const file = diaryPath(root, groupId, who.id);
      let old = { name: who.name, userId: who.id, intro: '', events: [] };
      try {
        old = { ...old, ...parseDiary(fs.readFileSync(file, 'utf8')), userId: who.id };
      } catch {
        /* 第一次写，用默认空日记 */
      }
      const merged = mergeDiary(old, [{ at: now, text: ev.text }], { name: who.name });
      writeDiaryFile(file, renderDiary(merged));
      written += 1;
    }

    lastDiaryAt.set(groupId, now);
    log('info', `群友日记已更新：${written} 条（群 ${groupId}）`);
    trace.write('diary', { groupId, written, events: events.slice(0, 5) });
    return { written, events };
  }

  /** 每个会话上一条消息的时间：判断冷场 */
  /** @type {Map<string, number>} */
  const lastSeenAt = new Map();

  // ── 新人实时建档 ──
  //
  // 批量更新印象是 6 小时一次，新人当天可能一直没档案：认不出人、关系判成陌生、
  // 回话也生硬。这里在**第一次见到某人**时就给他建一条（只有名字和号，印象留空待补）。
  //
  // 性能：seenPeople 缓存"已经确认有档案的人"，命中就直接 return，
  // 不会每条消息都去读一次记忆文件。
  /** @type {Set<string>} 已确认有档案的 "群号:QQ号" */
  const seenPeople = new Set();
  /** @type {Set<string>} 读不到记忆文件的群，别反复试 */
  const noMemoryFile = new Set();
  /** @type {Map<string, number>} "群号:QQ号" → 上次检查改名的时间 */
  const lastRenameCheck = new Map();

  /**
   * @param {string} key sessionKey
   * @param {any} msg
   */
  /**
   * 是不是官方机器人 / 管家类账号。
   *
   * 这些不是群友：不建档、不参与关系判定。
   * 判据只看名字（协议端口径不一，有的给 isRobot 有的不给），宁可漏判也别误杀真人——
   * 所以只匹配明确的机器人词，不用"助手""小助手"这种真人也会用的。
   *
   * @param {string} name
   */
  function isBotAccount(name) {
    const n = String(name ?? '');
    if (!n) return false;
    return /群管家|群助手|Q群|bot$|机器人$|^.bot|官方客服|系统消息/i.test(n);
  }

  /**
   * 群友改名同步：记忆里的名字跟着群名片走。
   *
   * 频控：每人最多每 6 小时查一次盘 —— 名字不会每分钟变，
   * 每条消息都读一遍记忆文件纯属浪费。
   *
   * 只改「名字」那一小段，「**（QQ xxx）**」和冒号后面的印象一个字不动。
   *
   * @param {string} groupId
   * @param {string} userId
   * @param {string} liveName 当前群名片
   */
  function syncRename(groupId, userId, liveName) {
    const key = `${groupId}:${userId}`;
    const now = Date.now();
    if (now - (lastRenameCheck.get(key) ?? 0) < RENAME_CHECK_MS) return;
    lastRenameCheck.set(key, now);
    if (noMemoryFile.has(groupId)) return;

    try {
      const file = path.join(config.memoryDir, `${groupId}.md`);
      let memory;
      try {
        memory = fs.readFileSync(file, 'utf8');
      } catch {
        noMemoryFile.add(groupId);
        return;
      }
      const { memory: next, changed } = renameInMemory(memory, userId, liveName);
      if (!changed) return;
      writeMemorySafely(file, next);
      log('info', `群友改名已同步：${liveName}（${userId}）@ ${groupId}`);
      trace.write('rename', { groupId, userId, name: liveName });
    } catch (error) {
      // 改名失败不影响这条消息的处理
      log('warn', `群友改名同步失败（${userId}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 从按天落盘的历史日志里读消息（给状态观察用）。
   *
   * 内存里那个 history 只有 200 条，用来比「最近 vs 平时」根本不够 ——
   * 得翻当天的日志文件。只读最近几个文件，且只读到需要的字段。
   *
   * 读不到就返回空数组：状态观察是锦上添花，不能因为它让面板崩掉。
   *
   * @param {number} since 只要这个时间之后的
   * @returns {Array<{senderId:string, senderName:string, time:number, text:string}>}
   */
  function readHistoryLogs(since) {
    if (!historyDir) return [];
    try {
      if (!fs.existsSync(historyDir)) return [];
      const files = fs
        .readdirSync(historyDir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .slice(-10); // 最多翻 10 天，再多没必要
      const out = [];
      for (const f of files) {
        let raw;
        try {
          raw = fs.readFileSync(path.join(historyDir, f), 'utf8');
        } catch {
          continue;
        }
        for (const line of raw.split('\n')) {
          if (!line.startsWith('{')) continue;
          let j;
          try {
            j = JSON.parse(line);
          } catch {
            continue;
          }
          if (j.type !== 'recv') continue;
          const time = Number(j.time);
          if (!(time >= since)) continue;
          const senderId = String(j.senderId ?? '');
          const text = String(j.text ?? '');
          if (!senderId || !text) continue;
          out.push({
            // 群号（group:xxx）—— 状态观察要按群分开算，没这个字段就只能全混一起
            key: String(j.key ?? ''),
            senderId,
            senderName: String(j.senderName ?? senderId),
            time,
            text,
          });
        }
      }
      return out;
    } catch (error) {
      log('warn', `读历史日志失败（状态观察）：${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  function noteStranger(key, msg) {
    const ic = cfg().impressions;
    if (ic === false || ic?.enabled === false || ic?.autoAddPeople === false) return;
    if (!config.memoryDir) return;
    if (!String(key).startsWith('group:')) return; // 只给群成员建档
    const groupId = String(key).slice('group:'.length);
    const senderId = String(msg?.sender?.id ?? '').trim();
    const senderName = String(msg?.sender?.name ?? '').trim();
    if (!senderId || !senderName) return;
    // 官方机器人 / 管家类账号不建档：它们不是群友，建了也是噪声，
    // 而且名字里带"群管""管理"还会被关系判定误认成管理员。
    if (isBotAccount(senderName)) return;

    // 改名同步：不管有没有建过档，名字变了就跟着改。
    // 放在建档之前 —— 有时候人已经在档案里了，只是名字旧了。
    if (ic?.syncRename !== false) syncRename(groupId, senderId, senderName);

    const mark = `${groupId}:${senderId}`;
    if (seenPeople.has(mark) || noMemoryFile.has(groupId)) return;

    try {
      const file = path.join(config.memoryDir, `${groupId}.md`);
      let memory;
      try {
        memory = fs.readFileSync(file, 'utf8');
      } catch {
        noMemoryFile.add(groupId);
        return;
      }
      // 已有档案（按号或名字）→ 记进缓存，以后不再查
      if (hasPersonEntry(memory, { name: senderName, id: senderId })) {
        seenPeople.add(mark);
        return;
      }
      const { memory: next, added } = addPersonEntry(memory, {
        name: senderName,
        id: senderId,
        note: '刚进群的，还没摸清脾气',
      });
      if (!added) {
        seenPeople.add(mark); // 段落满/没这一节 → 也算处理过，别反复试
        return;
      }
      writeMemoryFile(file, next);
      seenPeople.add(mark);
      log('info', `新群友已建档：${senderName}(${senderId}) @ ${groupId}`);
      historyLog.write('impression-new', {
        key,
        name: senderName,
        id: senderId,
      });
    } catch (error) {
      // 建档失败不影响这条消息的处理
      log('warn', `新群友建档失败（${key}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 面板用的消息流水（只留最近 200 条，给 /qq-kit 页面看） */
  /** @type {any[]} */
  const history = [];

  // 启动时从今天的日志回填 history。
  //
  // 为什么必须回填：history 是纯内存的，DSH 一重启就清空，
  // 于是面板上「消息」显示 0、「最近一条」空白 —— 哪怕群里刚刚还在聊，
  // 日志文件里明明躺着几百条。看起来就像"收不到消息"，其实只是没读回来。
  //
  // 只读当天、只要最近 200 条（跟内存上限一致），不碰冷启动之外的情况。
  try {
    if (historyDir && fs.existsSync(historyDir)) {
      const today = new Date().toISOString().slice(0, 10);
      const file = path.join(historyDir, `history-${today}.jsonl`);
      if (fs.existsSync(file)) {
        const recs = [];
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line.startsWith('{')) continue;
          let j;
          try {
            j = JSON.parse(line);
          } catch {
            continue;
          }
          if (j.type !== 'recv') continue;
          const key = String(j.key ?? '');
          const text = String(j.text ?? '');
          if (!key || !text) continue;
          recs.push({
            key,
            id: j.id,
            sender: String(j.senderName ?? ''),
            senderId: String(j.senderId ?? ''),
            text,
            time: Number(j.time) || 0,
            // 这几个字段只有实时消息才有，回填的一律留空
            thought: '',
            reply: '',
            replyAt: 0,
          });
        }
        // 只留最后 200 条，跟运行时上限一致
        const tail = recs.slice(-200);
        history.push(...tail);
        if (tail.length) log('info', `从今天的日志回填了 ${tail.length} 条消息流水`);
      }
    }
  } catch (error) {
    // 回填失败不影响收发，只是面板上少点历史
    log('warn', `回填消息流水失败：${error instanceof Error ? error.message : String(error)}`);
  }

  // ── 往 mood-kit 面板贡献 QQ 侧数据 ──
  //
  // mood-kit 是独立插件，它不知道有 QQ 在跑。这里反向注册一个供给函数，
  // 面板渲染时会调它拿"会话 / 最近消息 / 可调参数"，于是 /mood-kit 成了一个总面板。
  // 没装 mood-kit 时这段什么都不做（ctx.get 返回 undefined），不影响功能。
  try {
    const hubOwner = typeof ctx.get === 'function' ? ctx.get('moodKit') : null;
    if (hubOwner?.panel?.contribute) {
      const dispose = hubOwner.panel.contribute('qq-kit', {
        /** 面板要的数据 */
        data: () => {
          const live0 = cfg();
          const sessions = [...new Set([...router.list().map((r) => `group:${r.chatId}`), ...history.map((h) => h.key)])]
            .map((key) => {
              const items = window.get(key);
              const hist = history.filter((h) => h.key === key);
              const routed = router.list().some((r) => `group:${r.chatId}` === key);

              // 「最近一条」优先看窗口里那条（带完整 segments），
              // 窗口空了就退回 history 里最后一条 —— 只用窗口的话，
              // 冷场一轮之后这一列会突然变空，看着像消息没收到。
              const lastWin = items[items.length - 1];
              const lastHist = hist[hist.length - 1];
              let lastText = '';
              let lastSender = '';
              let lastAt = null;
              if (lastWin) {
                lastText = toPlainText(lastWin.segments).slice(0, 120);
                lastSender = lastWin.sender?.name ?? '';
                lastAt = lastWin.time ?? null;
              } else if (lastHist) {
                lastText = String(lastHist.text ?? '').slice(0, 120);
                lastSender = String(lastHist.sender ?? '');
                lastAt = lastHist.time ?? null;
              }

              return {
                key,
                routed,
                // 「消息」这一列给的是**今天收到多少条**（history 不被清空），
                // 不是窗口里还剩几条 —— 窗口每轮清空，拿它当"消息数"会让人以为没收到。
                count: hist.length,
                // 窗口里攒着多少条上下文，另开一列，不混淆
                windowCount: items.length,
                lastText,
                lastSender,
                lastAt,
              };
            });
          return {
            connection: { connected: Boolean(adapter.running), url: adapter.url ?? '' },
            config: {
              adapter: live0.adapter,
              dryRun: Boolean(live0.dryRun),
              summarizeEvery: Number(live0.summarizeEvery) || 1,
              coldSilenceMs: Number(live0.coldSilenceMs) || 30000,
              merge: {
                perMinute: Number(live0.merge?.perMinute ?? 1),
                windowMs: Number(live0.merge?.windowMs ?? 800),
                maxMessages: Number(live0.merge?.maxMessages ?? 20),
              },
            },
            liveConfigFile: live.file,
            sessions,
            recent: history.slice(-30).reverse(),
            // 代码没重启的提醒（mood-kit 面板也会显示）
            stale: changedSince(bootSnapshot),
            // 状态观察：从今天+昨天的流水里看每个人的作息/活跃度/语言变化。
            //
            // 这只是**行为统计**，不是心理判断 —— 前端也按"值得留意"来措辞，
            // 不给任何诊断标签。
            //
            // 默认只算、不主动关心。以后要做主动关心，读这里的 signals 就行。
            stateWatch: (() => {
              const sw = cfg().stateWatch;
              if (sw === false || sw?.enabled === false) return { people: [], note: '未启用' };
              try {
                // 只用最近 10 天的流水：基线窗口就 7 天，再往前没意义
                const cutoff = Date.now() - 10 * 24 * 60 * 60 * 1000;
                const recentRecs = history
                  .filter((h) => h.time >= cutoff && h.senderId && h.text)
                  .map((h) => ({
                    key: h.key,
                    senderId: h.senderId,
                    senderName: h.sender,
                    time: h.time,
                    text: h.text,
                  }));
                // 内存里只有 200 条，不够比基线 —— 从当天落盘日志补
                const fromLog = readHistoryLogs(cutoff);
                const records = fromLog.length ? fromLog : recentRecs;
                // limit 传 0（或没配）就是不限制，别再拿 || 兜到 8 —— 那等于又偷偷截断
                const lim = Number(sw?.limit);
                // 按群分开算：同一个号在两个群里状态可能完全不同，混着算会把两边都稀释
                const byGroup = findNotableByGroup(records, { limit: Number.isFinite(lim) ? lim : 0 });
                const mapPeople = (rows) =>
                  rows.map((r) => ({
                    id: r.id,
                    name: r.name,
                    warns: r.warns,
                    // 严重度：面板按这个从高到低排
                    severity: r.severity,
                    // 「可能只是忙」「像是心里有事」这类猜测标签
                    tags: r.tags ?? [],
                    note: r.state.note,
                    signals: r.state.signals,
                  }));
                const groups = byGroup.groups.map((g) => {
                  const chatId = String(g.key).startsWith('group:') ? String(g.key).slice('group:'.length) : '';
                  const rule = chatId ? router.list().find((r) => r.chatKind === 'group' && String(r.chatId) === chatId) : null;
                  return {
                    key: g.key,
                    // 面板上显示的名字：路由里配了 label 就用它，否则用群号
                    label: rule?.label || chatId || g.key,
                    people: mapPeople(g.people),
                  };
                });
                return {
                  groups,
                  // 兼容老面板：把所有人摊平放一份
                  people: groups.flatMap((g) => g.people),
                  note: '',
                };
              } catch (error) {
                log('warn', `状态观察失败：${error instanceof Error ? error.message : String(error)}`);
                return { groups: [], people: [], note: '计算失败' };
              }
            })(),
            // 群友日记：让情绪面板里直接能翻，不用另外开一个页面。
            //
            // 只给最近活跃的几个人、每人最多 30 条 —— 面板 2 秒刷一次，
            // 数据包太大每次都在传没意义。
            diary: (() => {
              const dc = cfg().diary;
              const root =
                dc?.dir || (config.memoryDir ? path.join(path.dirname(config.memoryDir), 'qq-diary') : '');
              if (dc === false || dc?.enabled === false || !root) return { root: '', groups: [] };
              try {
                const groups = router
                  .list()
                  .filter((r) => r.chatKind === 'group')
                  .map((r) => {
                    const gid = String(r.chatId);
                    const people = listDiaryPeople(root, gid, { roster: memoryRoster(gid), ownerId: String(cfg().ownerId || "") }).slice(0, 40);
                    const diaries = {};
                    for (const p of people) {
                      diaries[p.userId] = readDiary(root, gid, p.userId)
                        .split(/\r?\n/)
                        .filter((l) => /^\s*[-*]\s+\d{2}-\d{2}/.test(l))
                        .slice(-30)
                        .join('\n');
                    }
                    return { id: gid, people, diaries };
                  });
                return { root, groups };
              } catch (error) {
                trace.write('diary-panel-error', {
                  message: error instanceof Error ? error.message : String(error),
                });
                return { root, groups: [] };
              }
            })(),
          };
        },
        /**
         * 面板上改参数 → 写进热更新文件 → 立刻生效（不用重启）。
         * 只接受这些安全字段；其它字段写进去也会被 live-config 的白名单挡掉。
         */
        apply: (patch) => {
          const next = live.writePatch(patch ?? {});
          log('info', `面板调参：${JSON.stringify(patch).slice(0, 200)}`);
          return {
            dryRun: next.dryRun,
            summarizeEvery: next.summarizeEvery,
            coldSilenceMs: next.coldSilenceMs,
            merge: next.merge,
          };
        },
      });
      ctx?.effect?.(() => dispose, `${name}.panel-contribute`);
      log('info', '已向 mood-kit 面板贡献 QQ 数据（含在线调参）');
    }
  } catch (error) {
    log('warn', `向 mood-kit 贡献面板数据失败（不影响收发）: ${error instanceof Error ? error.message : String(error)}`);
  }

  // ── 情绪：优先用外部 mood-kit 插件，没有就内置一份 ──
  //
  // 装了 dsh-mood-kit 时，它通过 ctx.moodKit 提供服务；这里只负责 observe 和读 current。
  // 没装时用内置降级实现（同样的状态机，只是不带独立面板），保证功能不缺。
  //
  // 为什么这么接：情绪逻辑（沿用上限、老化、放大、分类、人物星系）跟"QQ"没关系，
  // 别的聊天插件也想用同一套 —— 抽成 mood-kit 后，这里只剩"喂数据"这一步。
  //
  // ⚠️ cordis 的 ctx 是 Proxy：没在 inject 里声明的属性直接读会抛
  //    `cannot get property "moodKit" without inject`。
  //    可选依赖要用 ctx.get()（拿不到返回 undefined，不抛），不能用 ctx.xxx。
  let externalMood = null;
  try {
    externalMood = typeof ctx.get === 'function' ? ctx.get('moodKit') : null;
  } catch {
    // get 也拿不到就当没装 —— 这不该阻止插件启动
    externalMood = null;
  }
  if (!externalMood || typeof externalMood.observe !== 'function') externalMood = null;
  const mood = externalMood ?? createBuiltinMood(config, log);
  log('info', externalMood ? '情绪：使用外部 mood-kit 插件' : '情绪：使用内置实现（未装 dsh-mood-kit）');

  // 把关系判定交给 mood-kit：面板上的人物星系就用我们这套（带防冒充的）。
  //
  // 不然两边各算各的：qq-kit 判"熟人"，面板可能判成"主人"，
  // 用户看到的就是自相矛盾的画面。
  if (externalMood && typeof externalMood.setRelationshipJudge === 'function') {
    try {
      externalMood.setRelationshipJudge((memory, userId) => {
        const ownerId = String(cfg().ownerId || '').trim();
        let rel = relationshipOf(memory, userId);
        // 跟对话层同一条规则：配了 ownerId，只有那个号能是主人
        if (ownerId && rel === 'owner' && String(userId) !== ownerId) rel = 'stranger';
        return rel;
      });
      log('info', '人物关系判定：已交给 qq-kit（面板与对话层同一套规则）');
    } catch (error) {
      log('warn', `注册关系判定失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 一批消息到了：落会话键 → 交给两段式桥接 → 执行侧发送 */
  merger.setHandler(async (key, items) => {
    const last = items[items.length - 1];
    const route = router.resolve(last);
    if (!route) {
      log('debug', `${key} 没有路由规则，跳过`);
      return;
    }
    // 有人 @ 了"别人的号"（比如主人的号）：不调模型，直接硬发一句提醒。
    // 这样不依赖模型记不记得，也不会漏。
    if (mentionOfWatched(last)) {
      const text = String(config.notifyOnMention?.text ?? '有人点你');
      // 提醒里把被 @ 的人真正 @ 出来（配置里 at 给了号才加），这样他手机上能看到红点
      const atIds = (config.notifyOnMention?.at ?? []).map(String).filter(Boolean);
      const segments = [
        ...atIds.map((id) => ({ type: 'at', id })),
        ...(atIds.length ? [{ type: 'text', text: ' ' }] : []),
        { type: 'text', text },
      ];
      const plan = { chatKind: last.chatKind, chatId: last.chatId, segments, mode: 'reply' };
      log('info', `[提醒] ${key} 有人 @ 了被盯的号，发: ${JSON.stringify(segments)}`);
      trace.write('notify-mention', { key, segments });
      try {
        if (!cfg().dryRun) await sender.send(plan);
      } catch (error) {
        log('warn', `提醒发送失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    try {
      let result;
      // 摘要优先从磁盘取：重启后还能接上上一轮的上下文
      const previousSummary = summaries.get(key) ?? store.get(key);
      // 识图：图片 URL 有时效，必须现在就去下载
      let images = [];
      if (cfg().vision !== false) {
        try {
          images = await loadImagesFromMessages(items, {
            maxImages: Number(cfg().vision?.maxImages) || 3,
            maxBytes: Number(cfg().vision?.maxBytes) || undefined,
          });
          if (images.length) trace.write('images', { key, count: images.length, types: images.map((i) => i.mediaType) });
        } catch (error) {
          log('warn', `图片下载失败（本轮当无图处理）: ${error instanceof Error ? error.message : String(error)}`);
          images = [];
        }
      }
      // 视频抽帧：视频里的画面也当图看一眼，不然短视频等于没收到
      if (config.videoFrames && config.videoFrames.ffmpeg) {
        try {
          const frames = await loadFramesFromMessages(items, {
            ffmpeg: config.videoFrames.ffmpeg,
            ffprobe: config.videoFrames.ffprobe,
            maxVideos: Number(config.videoFrames.maxVideos) || 1,
            framesPerVideo: Number(config.videoFrames.frames) || 3,
            maxBytes: Number(config.videoFrames.maxBytes) || undefined,
          });
          if (frames.length) {
            trace.write('frames', { key, count: frames.length });
            images = [...images, ...frames];
          }
        } catch (error) {
          log('warn', `视频抽帧失败（本轮当无视频处理）: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try {
        result = await bridge.run({
          sessionKey: key,
          route,
          messages: items,
          window: window.get(key),
          summary: previousSummary ?? null,
          images,
        });
      } catch (bridgeError) {
        // 真子代理挂了不要吞掉整批：退回占位实现，至少让链路继续跑
        const message = bridgeError instanceof Error ? bridgeError.message : String(bridgeError);
        log('warn', `${key} 子代理失败，本轮退回占位: ${message}`);
        trace.write('bridge-fallback', { key, error: message.slice(0, 400) });
        result = await bridge.run({
          sessionKey: key,
          route,
          messages: items,
          window: window.get(key),
          summary: previousSummary ?? null,
        }).catch(() => ({ summary: previousSummary ?? null, plan: null }));
      }
      // 把这一轮的情绪交给情绪中枢（外部 mood-kit 或内置降级）。
      // 状态机（去照抄/沿用上限/老化/放大）都在中枢里，这里只喂原始值。
      const { summary, plan } = result;
      const observed = mood.observe({
        sessionKey: key,
        mood: summary?.mood ?? '',
        intensity: summary?.intensity ?? 0,
        summaryText: summary?.text ?? '',
      });
      // 摘要里同步一份处理后的情绪，方便下一轮 prompt 直接用
      if (summary) {
        summary.mood = observed.mood;
        summary.intensity = observed.intensity;
      }
      summaries.set(key, summary);
      // 落盘：重启后还能接着上一轮的上下文（情绪跟着摘要一起存）
      if (summary?.text || summary?.mood) store.set(key, summary);
      trace.write('plan', {
        key,
        summary: summary?.text?.slice(0, 500),
        mood: observed.mood,
        intensity: observed.intensity,
        carried: observed.carried,
        classification: observed.classification,
        plan,
      });
      if (!plan || plan.mode === 'none') {
        log('debug', `${key} 思考子代理决定不发`);
        historyLog.write('plan', {
          key,
          action: 'silent',
          mood: summary?.mood ?? '',
          intensity: summary?.intensity ?? 0,
          thought: plan?.thought ?? '',
        });
        return;
      }
      // 把"心里那一下"挂到触发它的那条消息上，面板的最近消息里就能并排看到：
      //   谁说了什么 → 它心里怎么想的 → 它回了什么
      // 只进面板流水（history 是给 /qq-kit 和贡献给 mood-kit 的），不进群。
      //
      // thought 兜底：提示词里模板、示例、"必须写"全摆上了，模型还是经常留空
      // （实测 trace 里 thought='' 是常态）。空着就等于这一栏白留，
      // 所以退回用 mood —— 它本来就有值，也最接近"心里那一下"。
      const trigger = items[items.length - 1];
      const entry = trigger ? history.find((h) => h.id === trigger.id) : null;
      if (entry) {
        const planThought = String(plan.thought ?? '').trim();
        const moodText = String(summary?.mood ?? '').trim();
        entry.thought = planThought || moodText || '';
        entry.reply = toPlainText(plan.segments);
        entry.replyAt = Date.now();
      }
      if (cfg().dryRun) {
        // 只观察模式：打印最终计划，不真的发到群里
        log('info', `[dryRun] ${key} 会发: ${JSON.stringify(plan.segments).slice(0, 300)}`);
        historyLog.write('plan', {
          key,
          action: 'dryRun',
          text: toPlainText(plan.segments),
          mood: summary?.mood ?? '',
          intensity: summary?.intensity ?? 0,
          thought: plan.thought ?? '',
        });
        return;
      }
      await sender.send(plan);
      trace.write('sent', { key, plan });
      historyLog.write('sent', {
        key,
        text: toPlainText(plan.segments),
        mode: plan.mode,
        mood: summary?.mood ?? '',
        intensity: summary?.intensity ?? 0,
      });
    } catch (error) {
      // 桥接或发送失败都不能影响后续消息
      const message = error instanceof Error ? error.message : String(error);
      log('warn', `处理 ${key} 失败: ${message}`);
      historyLog.write('error', { key, message: message.slice(0, 400) });
    }
  });

  // 用量看门狗：今天花费到阈值时私聊通知一次（数据来自鲸鱼小组件的用量账本）
  let usageWatch = null;
  if (config.notifyUsage?.threshold > 0 && config.notifyUsage?.target) {
    const usageFile =
      config.notifyUsage.file ||
      path.join(process.env.DSH_HOME ?? os.homedir(), '.dshw-usage.json');
    usageWatch = createUsageWatch({
      file: usageFile,
      threshold: Number(config.notifyUsage.threshold),
      intervalMs: Number(config.notifyUsage.intervalMs) || 60000,
      warn: (m) => log('warn', m),
      onExceed: async ({ today, threshold }) => {
        // 私聊通知：target 形如 private:<QQ号>
        const target = String(config.notifyUsage.target);
        const chatId = target.replace(/^private:/, '');
        const text = String(config.notifyUsage.text ?? '').replace(/\{today\}/g, today.toFixed(2)).replace(/\{threshold\}/g, String(threshold));
        log('info', `[用量] 今日 ${today.toFixed(2)} 已到 ${threshold}，通知 ${target}: ${text}`);
        trace.write('notify-usage', { today, threshold, target, text });
        if (cfg().dryRun) return;
        await sender.send({ chatKind: 'private', chatId, segments: [{ type: 'text', text }], mode: 'reply' });
      },
    });
    usageWatch.start();
    log('info', `用量看门狗已启动：阈值 ${config.notifyUsage.threshold}，账本 ${usageFile}`);
  }

  // ── 群友印象的定时刷新 ──
  //
  // 每个路由群一个循环，间隔跟着配置走。第一次不立刻跑：
  // 刚启动时 agents 可能还没就绪，而且一上来就写记忆文件也不礼貌。
  let impressionsTimer = null;
  if (cfg().impressions !== false && cfg().impressions?.enabled !== false) {
    const tickMs = 30 * 60 * 1000; // 每 30 分钟看一次"该不该更新了"
    impressionsTimer = setInterval(() => {
      if (!agents) return; // 子代理没就绪就跳过这一拍
      for (const rule of router.list()) {
        if (rule.chatKind !== 'group') continue;
        const gid = String(rule.chatId);
        void refreshImpressions(gid).catch((error) => {
          log('warn', `群友印象更新失败（${gid}）：${error instanceof Error ? error.message : String(error)}`);
        });
        // 日记跟着印象一起跑：同一批流水，多一次调用换一份时间线
        void refreshDiaries(gid).catch((error) => {
          log('warn', `群友日记更新失败（${gid}）：${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }, tickMs);
    impressionsTimer.unref?.();
    log('info', '群友印象自动更新已启用（每 30 分钟检查一次，实际间隔看配置）');
  }

  // ── QQ 空壳会话的定时归档 ──
  //
  // qq-kit 每轮对话都让 DSH 建一个 agent 会话，几天就堆出几千个，
  // 左侧栏全是"新会话"，看不出哪个是哪个。
  //
  // 这些会话文件里只有元信息、没有对话内容（正文在 history-*.jsonl），
  // 所以挪走是零损失的；而且只挪不删，随时能挪回来。
  let archiveTimer = null;
  const archiveCfg = cfg().archive;

  /** 跑一次归档；返回统计，面板/日志都用它 */
  function runArchive() {
    const ac = cfg().archive;
    if (ac === false || ac?.enabled === false) return { moved: 0, reason: 'disabled' };
    const dshHome = process.env.DSH_HOME ?? os.homedir();
    const sessionsRoot = ac?.sessionsRoot || path.join(dshHome, 'sessions');
    const backupRoot = ac?.backupRoot || path.join(dshHome, 'sessions-backup');
    if (!fs.existsSync(sessionsRoot)) return { moved: 0, reason: 'no sessions dir' };
    try {
      const found = findArchivable({
        sessionsRoot,
        keepDays: Number(ac?.keepDays) || 7,
        onlyEmpty: ac?.onlyEmpty !== false,
      });
      if (found.candidates.length === 0) {
        return { moved: 0, scanned: found.scanned, kept: found.skippedWithContent };
      }
      const res = archiveSessions(found.candidates, { backupRoot });
      log(
        'info',
        `会话归档：挪走 ${res.moved} 个空壳（保留 ${found.skippedWithContent} 个有内容的）→ ${res.target}`,
      );
      trace.write('archive', {
        moved: res.moved,
        failed: res.failed,
        kept: found.skippedWithContent,
        scanned: found.scanned,
        target: res.target,
      });
      return { moved: res.moved, failed: res.failed, kept: found.skippedWithContent, target: res.target };
    } catch (error) {
      log('warn', `会话归档失败：${error instanceof Error ? error.message : String(error)}`);
      return { moved: 0, reason: 'error' };
    }
  }

  if (archiveCfg !== false && archiveCfg?.enabled !== false) {
    const intervalMs = Math.max(60 * 1000, Number(archiveCfg?.intervalMs) || 6 * 60 * 60 * 1000);
    // 启动后先等两分钟再跑第一次：刚起来时别和一堆初始化抢 IO
    const kickoff = setTimeout(() => {
      void runArchive();
    }, 2 * 60 * 1000);
    kickoff.unref?.();
    archiveTimer = setInterval(() => {
      void runArchive();
    }, intervalMs);
    archiveTimer.unref?.();
    log('info', `会话归档已启用：${Math.round(intervalMs / 3600000)} 小时检查一次，超过 ${archiveCfg?.keepDays || 7} 天的空壳会话挪到备份目录`);
  }

  const wireAdapter = (next) => {
    next.setEvents({
      onMessage: (msg) => {
        const key = sessionKeyOf(msg);
        // 人格热更新：改了 soul.md 下一条消息就生效（只是 statSync，很便宜）
        refreshPersona();
        trace.write('recv', {
          key,
          id: msg.id,
          sender: msg.sender?.name,
          segments: msg.segments,
        });
        // 新人实时建档：第一次见到就写进群记忆，别等 6 小时后的批量更新。
        // 这里有内存缓存挡着，同一个人只查一次盘，不会每条消息都读文件。
        noteStranger(key, msg);
        window.push(key, msg);
        const prevAt = lastSeenAt.get(key);
        const now = Date.now();
        lastSeenAt.set(key, now);
        // 面板流水：只留最近 200 条
        history.push({
          key,
          id: msg.id,
          sender: msg.sender?.name ?? msg.sender?.id ?? '',
          // 发送者的号（QQ 号或 openid）。
          //
          // 之前只存名字，于是日记提炼时「谁说的」只能靠名字猜 ——
          // 群里两个人同名、或者有人改名，就全乱了。
          // 名字会变，号不会，所以这一列是必须的。
          senderId: String(msg.sender?.id ?? ''),
          text: toPlainText(msg.segments),
          time: msg.time,
          // 这两个由 plan 回来后回填（面板上并排显示"它怎么想的 / 它回了什么"）。
          // 先占位，免得模板里到处判 undefined。
          thought: '',
          reply: '',
          replyAt: 0,
        });
        if (history.length > 200) history.splice(0, history.length - 200);
        // 历史日志：按天落盘，给复盘用（面板只留 200 条，这个是长期记录）
        historyLog.write('recv', {
          key,
          id: msg.id,
          senderId: msg.sender?.id ?? '',
          senderName: msg.sender?.name ?? '',
          text: toPlainText(msg.segments),
          time: msg.time,
        });
        merger.push(msg);
        // 消息已经进了合并队列和窗口，冷场只是"让它现在就触发"，不丢消息
        if (prevAt !== undefined && now - prevAt > cfg().coldSilenceMs) {
          merger.flush(key);
        }
      },
      onStatus: (info) => log(info.connected ? 'info' : 'warn', `适配器状态: ${JSON.stringify(info)}`),
      onError: (error) => log('warn', `适配器错误: ${error.message}`),
    });
    return next;
  };
  wireAdapter(adapter);

  ctx?.effect?.(() => () => {
    merger.close();
    agents?.dispose?.();
    usageWatch?.stop();
    // 停掉群友印象定时器
    if (impressionsTimer) clearInterval(impressionsTimer);
    void adapter.stop();
    // 停掉热更新轮询
    live.stop();
    // 退出前把摘要和情绪历史落盘，别丢最后一轮
    store.save();
    mood.save();
    historyLog.write('plugin/shutdown', {});
    historyLog.close();
    trace.write('shutdown');
    trace.close();
  }, `${name}.lifecycle`);

  // 面板：/qq-kit 显示 HTML，/qq-kit/api/state 给 JSON。
  // webServer 用 ctx.inject 迟到接入，拿不到服务也不影响收发。
  if (config.panel !== false) {
    try {
      ctx.inject?.(['webServer'], (child) => {
        child.effect(() => {
          const disposers = [];
          disposers.push(
            child.webServer.register({
              kind: 'exact',
              path: '/qq-kit',
              handler: (_req, res) => {
                const html = renderPanelHtml();
                res.writeHead(200, {
                  'Content-Type': 'text/html; charset=utf-8',
                  'Content-Length': Buffer.byteLength(html),
                  'Cache-Control': 'no-store',
                });
                res.end(html);
              },
            }),
            child.webServer.register({
              kind: 'exact',
              path: '/qq-kit/api/state',
              handler: (_req, res) => {
                const payload = JSON.stringify(
                  collectState({
                    adapter,
                    window,
                    router,
                    summaries,
                    history,
                    // 面板必须看到"当前生效"的配置（含热更新覆写），否则改了文件面板还显示旧值
                    config: cfg(),
                    liveConfigFile: live.file,
                    version: VERSION,
                    // 情绪数据：来自外部 mood-kit 或内置中枢，接口一致
                    moodState: mood,
                    externalMood: Boolean(externalMood),
                    // 改了代码没重启时，面板顶部顶一条黄条
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
            // 群友日记：/qq-kit/diary
            //
            // 单独的页面，不进情绪面板 —— 它回答的是"这个人身上发生过什么"，
            // 跟"整体情绪走势"不是一回事。
            child.webServer.register({
              kind: 'prefix',
              path: '/qq-kit/diary',
              handler: (req, res) => {
                const diaryRoot =
                  cfg().diary?.dir ||
                  (config.memoryDir ? path.join(path.dirname(config.memoryDir), 'qq-diary') : '');
                const url = new URL(req.url ?? '/', 'http://x');
                const wantGroup = url.searchParams.get('group') ?? '';
                const wantPerson = url.searchParams.get('person') ?? '';

                // 有路由的群才列出来
                const groups = router
                  .list()
                  .filter((r) => r.chatKind === 'group')
                  .map((r) => ({
                    id: String(r.chatId),
                    label: `群 ${r.chatId}`,
                    people: diaryRoot ? listDiaryPeople(diaryRoot, String(r.chatId), { roster: memoryRoster(String(r.chatId)), ownerId: String(cfg().ownerId || "") }) : [],
                  }));

                const activeGroup = groups.find((g) => g.id === wantGroup)?.id ?? groups[0]?.id ?? '';
                const people = groups.find((g) => g.id === activeGroup)?.people ?? [];
                // 没指定人就默认选第一个（最近说话的那个）。
                // 不然一进来右边是空的，看着像"没数据"——其实数据都在。
                const activePerson = people.find((p) => p.userId === wantPerson) ?? people[0] ?? null;

                // 一次性把所有群的日记原文都带上：前端点击时只换视图、不发请求。
                // 日记单文件最多 300 条事件，整包也就几十 KB，换掉每次点击的往返。
                const diaries = {};
                for (const g of groups) {
                  for (const p of g.people) {
                    diaries[`${g.id}/${p.userId}`] = readDiary(diaryRoot, g.id, p.userId);
                  }
                }

                const html = renderDiaryHtml({
                  groups,
                  diaries,
                  activeGroup,
                  activePerson,
                  content: activePerson ? readDiary(diaryRoot, activeGroup, activePerson.userId) : '',
                  root: diaryRoot,
                });
                res.writeHead(200, {
                  'Content-Type': 'text/html; charset=utf-8',
                  'Content-Length': Buffer.byteLength(html),
                  'Cache-Control': 'no-store',
                });
                res.end(html);
              },
            }),
            // 热更新接口：面板上改参数，写进 qq-kit-live.json，立刻生效
            child.webServer.register({
              kind: 'exact',
              path: '/qq-kit/api/tune',
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
                    const patch = JSON.parse(raw || '{}');
                    const next = live.writePatch(patch);
                    log('info', `热更新：${JSON.stringify(patch).slice(0, 200)}`);
                    send(200, { ok: true, config: { dryRun: next.dryRun, merge: next.merge, summarizeEvery: next.summarizeEvery } });
                  } catch (error) {
                    send(400, { ok: false, error: error instanceof Error ? error.message : String(error) });
                  }
                });
              },
            }),
          );
          return () => {
            for (const dispose of disposers.splice(0)) {
              try {
                dispose();
              } catch {
                /* 卸载失败不影响宿主 */
              }
            }
          };
        }, `${name}.panel`);
      });
    } catch (error) {
      log('warn', `面板注册失败（不影响收发）: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  void adapter.start().catch((error) => log('warn', `适配器启动失败: ${error.message}`));
  log('info', `qq-kit ${VERSION} 启动，适配器=${config.adapter}`);
  // 新用户第一次装时，说清楚数据都落在哪 —— 不然过几天找不到记忆和情绪存哪了
  log(
    'info',
    `数据目录：摘要 ${summaryFile || '(未配置)'}｜群记忆 ${config.memoryDir || '(未配置，认不出人)'}｜人格 ${config.personaPath || '(未配置，用内置中性人格)'}`,
  );

  // 调试接口挂在 ctx 上（不进返回值：cordis 把 apply 的返回值当 effect，非函数即 Invalid effect）。
  // 只在有 ctx 可用时挂；ctx 是 Proxy，写自定义属性前用 try 兜一下。
  const api = {
    get adapter() {
      return adapter;
    },
    merger,
    router,
    window,
    bridge,
    summaries,
    agents,
    /** 测试 / 调试用：换适配器（执行侧跟着换） */
    useAdapter(id, options = {}) {
      void adapter.stop();
      adapter = wireAdapter(registry.create(id, options));
      sender = createAdapterSender(adapter);
      void adapter.start().catch((error) => log('warn', `适配器启动失败: ${error.message}`));
      return adapter;
    },
    /** 换掉两个子代理的实现（接 DSH subagent 时用） */
    setAgents({ summarizer: s, thinker: t } = {}) {
      const next = createTwoStageBridge({
        summarizer: s ?? summarizer,
        thinker: t ?? thinker,
        window,
      });
      Object.assign(bridge, next);
    },
    /** 测试 / 调试用：直接改某个会话的"上次消息时间"，用来模拟冷场 */
    __setLastSeen(key, at) {
      lastSeenAt.set(key, at);
    },
    /** 手动发一条 */
    send(chatKind, chatId, segments) {
      return adapter.send({ chatKind, chatId, segments });
    },
    /**
     * 手动触发一次群友印象更新（调试用；正常由定时器跑）。
     * @param {string} groupId
     */
    refreshImpressions(groupId) {
      return refreshImpressions(String(groupId));
    },
    /**
     * 手动触发一次群友日记更新（调试用；正常跟印象一起由定时器跑）。
     * @param {string} groupId
     */
    refreshDiaries(groupId) {
      return refreshDiaries(String(groupId));
    },
    /**
     * 立刻跑一次会话归档。面板上的按钮和调试都用它。
     * @returns {{moved:number, failed?:number, kept?:number, target?:string, reason?:string}}
     */
    runArchive() {
      return runArchive();
    },
    /** 面板看情绪走势用（来自情绪中枢；未装 mood-kit 时是内置实现） */
    get moodHistory() {
      return mood.history;
    },
    /** 情绪中枢本体（调试/面板用） */
    get mood() {
      return mood;
    },
  };
  try {
    ctx.qqKit = api;
  } catch {
    /* 挂不上就算了，不影响收发 */
  }
}

export { AdapterBase, AdapterRegistry } from './src/adapter.js';
export { makeMessage, toSegment, toSegments, toPlainText, toOutboundSegments, ChatKind, isMention } from './src/message.js';
export { createMerger } from './src/merge.js';
export { sessionKeyOf, createRouter, createContextWindow } from './src/session.js';
export {
  createTwoStageBridge,
  createStubSummarizer,
  createStubThinker,
  createAdapterSender,
  validatePlan,
  renderMessages,
  normalizeMood,
} from './src/bridge.js';
export { carryMood } from './src/emotion.js';
