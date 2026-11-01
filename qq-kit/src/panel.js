/**
 * 面板页：把 QQ 侧的运行状态渲染成一个 HTML 页面。
 *
 * 页面只做展示，数据来自 /qq-kit/api/state；每 2 秒拉一次。
 * 刻意做得很朴素：不引任何前端框架，出问题时一眼能看出是数据空还是页面坏。
 */
import { toPlainText } from '../src/message.js';
import { moodDistribution, recentPoints, MOOD_CLASSES, classifyMood } from './mood-stats.js';
import { collectPeople, relationSummary } from './people.js';

/**
 * @typedef {object} PanelState
 * @property {{connected: boolean, url: string, detail?: string}} connection
 * @property {{adapter: string, dryRun: boolean, version: string}} config
 * @property {Array<object>} sessions
 * @property {Array<object>} recent
 * @property {{points: Array<{at: number, sessionKey: string, mood: string, polarity: number}>, latest: object|null}} moodHistory
 */

/**
 * 情绪历史：面板侧自己攒（最多 200 个点），不落盘。
 * 每个点记一条：什么时候、哪个会话、情绪原文、粗糙的极性分、模型给的强度。
 * 极性只是给曲线用的，**不是**给模型用的判据。
 * @typedef {{at: number, sessionKey: string, mood: string, polarity: number, intensity: number}} MoodPoint
 */

/** 面板侧情绪历史上限（够看好几天的走势；超出自动丢最早的） */
export const MOOD_HISTORY_MAX = 2000;

/** 情绪点在多快之内视为"同一个"，只更新时间、不新增点（避免一句话连写多条） */
export const MERGE_WINDOW_MS = 5 * 60 * 1000;

/** 正面/负面词，用来把一句情绪压成一个 -1..1 的分 */
const POSITIVE_WORDS = ['开心', '高兴', '美滋滋', '爽', '乐', '笑', '想接', '有精神', '来劲', '得意', '舒服', '喜欢', '感动', '暖和'];
const NEGATIVE_WORDS = ['不爽', '烦', '气', '懵', '没兴趣', '不想', '无语', '难受', '委屈', '敷衍', '膈应', '烦人', '累了', '困', '下头'];

/**
 * 把一句话情绪压成 -1..1 的极性分。
 * 粗糙是刻意的：只用来画走势，不做判断依据。
 * @param {string} mood
 * @returns {number}
 */
export function polarityOf(mood) {
  const text = String(mood ?? '');
  if (!text.trim()) return 0;
  let score = 0;
  for (const w of POSITIVE_WORDS) if (text.includes(w)) score += 1;
  for (const w of NEGATIVE_WORDS) if (text.includes(w)) score -= 1;
  // 否定词打个折：句子里有"不"时把正面信号减半（"不想接"已经算负面词了，这层是兜底）
  if (/不|没|别/.test(text) && score > 0) score -= 0.5;
  // 压到 -1..1
  return Math.max(-1, Math.min(1, score / 2));
}

/**
 * 往历史里追加一个点；情绪没变就不重复记（省得曲线上全是同一个值）。
 * @param {MoodPoint[]} history
 * @param {{at?: number, sessionKey: string, mood: string, intensity?: number}} next
 * @returns {MoodPoint}
 */
export function pushMoodPoint(history, next) {
  const point = {
    at: Number(next.at) || Date.now(),
    sessionKey: String(next.sessionKey ?? ''),
    mood: String(next.mood ?? ''),
    polarity: polarityOf(next.mood),
    intensity: Math.max(0, Math.min(10, Math.round(Number(next.intensity) || 0))),
  };
  const last = history[history.length - 1];
  // 同一个会话、同一个情绪、5 分钟内：覆盖最后一个点的时间，别把曲线撑满。
  // 原来只合并 1 分钟内的，导致同一句话被拆成很多重复点（"被点名"连写四条）。
  if (last && last.sessionKey === point.sessionKey && last.mood === point.mood && point.at - last.at < MERGE_WINDOW_MS) {
    last.at = point.at;
    last.intensity = point.intensity;
    return last;
  }
  history.push(point);
  if (history.length > MOOD_HISTORY_MAX) history.splice(0, history.length - MOOD_HISTORY_MAX);
  return point;
}

/**
 * 从插件运行时收集一份快照。
 * @param {{
 *   adapter: any,
 *   window: { get: (k: string) => any[] },
 *   router: { list: () => any[] },
 *   summaries: Map<string, any>,
 *   history: any[],
 *   config: object,
 *   version: string,
 *   moodHistory?: MoodPoint[],
 * }} deps
 * @returns {PanelState}
 */
export function collectState(deps) {
  const { adapter, window, router, summaries, history, config, version } = deps;
  // 情绪数据统一从"情绪中枢"取：装了 dsh-mood-kit 就是它，没装就是内置实现。
  // 兼容老的 moodHistory 直传（测试/旧调用方）。
  const moodState = deps.moodState ?? null;
  const moodHistory = deps.moodHistory ?? (moodState ? moodState.points() : []);
  const keys = new Set();
  for (const rule of router.list()) {
    keys.add(rule.chatKind === 'group' ? `group:${rule.chatId}` : `private:${rule.chatId}`);
  }
  // 出现过的会话也列出来，哪怕没配路由，方便确认收到了什么
  for (const item of history) keys.add(item.key);

  const sessions = [...keys].map((key) => {
    const items = window.get(key);
    const last = items[items.length - 1];
    const route = router.list().find((r) => {
      const k = r.chatKind === 'group' ? `group:${r.chatId}` : `private:${r.chatId}`;
      return k === key;
    });
    return {
      key,
      routed: Boolean(route),
      count: items.length,
      lastText: last ? toPlainText(last.segments).slice(0, 120) : '',
      lastSender: last?.sender?.name ?? '',
      lastAt: last?.time ?? null,
      summary: summaries.get(key)?.text ?? '',
      mood: summaries.get(key)?.mood ?? '',
    };
  });

  return {
    connection: {
      connected: Boolean(adapter?.running),
      url: adapter?.url ?? '',
    },
    config: {
      adapter: config.adapter,
      dryRun: Boolean(config.dryRun),
      version,
      // 下面这些是"参数调节"面板要用的，必须是热更新后的当前值
      summarizeEvery: Number(config.summarizeEvery) || 1,
      coldSilenceMs: Number(config.coldSilenceMs) || 30000,
      merge: {
        perMinute: Number(config.merge?.perMinute ?? 1),
        windowMs: Number(config.merge?.windowMs ?? 800),
        maxMessages: Number(config.merge?.maxMessages ?? 20),
      },
    },
    liveConfigFile: deps.liveConfigFile ?? '',
    sessions,
    recent: history.slice(-30).reverse(),
    moodHistory: {
      points: moodHistory.slice(-MOOD_HISTORY_MAX),
      latest: moodHistory.length ? moodHistory[moodHistory.length - 1] : null,
    },
    // 情绪星图：优先问中枢要（装 mood-kit 时走它的统计），否则本地算
    moodStats: moodState
      ? moodState.stats()
      : {
          all: moodDistribution(moodHistory),
          day: moodDistribution(recentPoints(moodHistory, 24)),
          hour: moodDistribution(recentPoints(moodHistory, 1)),
        },
    // 记忆星图：她跟群里每个人的关系
    people: (() => {
      const groupIds = router
        .list()
        .filter((r) => r.chatKind === 'group')
        .map((r) => String(r.chatId));
      // 优先问中枢（装 mood-kit 时它能合并多群、去重），否则本地抽
      if (moodState) {
        const p = moodState.people({ memoryDir: config.memoryDir, chatIds: groupIds });
        return { ...p, groupIds };
      }
      const list = collectPeople({ memoryDir: config.memoryDir, chatIds: groupIds });
      return { nodes: list, summary: relationSummary(list), groupIds };
    })(),
    // 情绪中枢来自哪个实现（面板可以标一下）
    moodSource: deps.externalMood ? 'mood-kit' : 'builtin',
  };
}

/** 面板页 HTML。 */
export function renderPanelHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QQ Kit 面板</title>
<style>
  :root{
    color-scheme:dark;
    --bg:#080b11; --bg2:#0d1219; --card:#111823; --card2:#16202e;
    --line:#1e2b3d; --line2:#2a3d55;
    --fg:#e8f0fa; --fg2:#8fa3bd; --fg3:#5a6b82;
    --ok:#4ade80; --bad:#f87171; --warn:#fbbf24; --accent:#38bdf8; --accent2:#22d3ee;
    --glow:rgba(56,189,248,.35);
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0;padding:0 0 48px;
    font:14px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background:
      radial-gradient(1400px 700px at 8% -12%, #10233a 0%, transparent 55%),
      radial-gradient(1000px 560px at 108% 6%, #0d2a2a 0%, transparent 50%),
      var(--bg);
    color:var(--fg);
    -webkit-font-smoothing:antialiased;
    position:relative;
    overflow-x:hidden;
  }
  /* 背景网格 + 扫描线 */
  body::before{
    content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
    background-image:
      linear-gradient(rgba(56,189,248,.035) 1px, transparent 1px),
      linear-gradient(90deg, rgba(56,189,248,.035) 1px, transparent 1px);
    background-size:44px 44px;
    mask-image:radial-gradient(ellipse 90% 70% at 50% 30%, #000 30%, transparent 85%);
    -webkit-mask-image:radial-gradient(ellipse 90% 70% at 50% 30%, #000 30%, transparent 85%);
  }
  body::after{
    content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
    background:repeating-linear-gradient(0deg, rgba(0,0,0,.11) 0 1px, transparent 1px 3px);
    opacity:.5;
  }
  .wrap{max-width:1240px;margin:0 auto;padding:26px 24px 0;position:relative;z-index:1}

  /* ── 顶栏 HUD ── */
  header{display:flex;align-items:center;gap:15px;margin-bottom:24px;flex-wrap:wrap;
    padding-bottom:18px;border-bottom:1px solid var(--line);position:relative}
  header::after{
    content:"";position:absolute;left:0;bottom:-1px;width:180px;height:2px;
    background:linear-gradient(90deg,var(--accent),transparent);
    box-shadow:0 0 10px var(--glow);
  }
  .logo{
    width:42px;height:42px;flex:none;position:relative;
    background:linear-gradient(135deg,#0ea5e9,#22d3ee 60%,#34d399);
    display:flex;align-items:center;justify-content:center;font-size:21px;
    clip-path:polygon(22% 0,100% 0,100% 78%,78% 100%,0 100%,0 22%);
    box-shadow:0 0 26px rgba(56,189,248,.4);
  }
  h1{font-size:20px;margin:0;letter-spacing:1.6px;font-weight:700;
    background:linear-gradient(90deg,#e8f0fa,#7dd3fc);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .sub{color:var(--fg3);font-size:11px;margin:3px 0 0;letter-spacing:2.2px;text-transform:uppercase}
  .live{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:11.5px;
    color:var(--fg2);letter-spacing:1.2px;text-transform:uppercase;
    background:rgba(17,24,35,.85);border:1px solid var(--line2);border-radius:3px;padding:7px 15px;
    box-shadow:inset 0 0 18px rgba(56,189,248,.07)}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--bad);box-shadow:0 0 10px var(--bad)}
  .dot.on{background:var(--ok);box-shadow:0 0 12px var(--ok);animation:pulse 1.8s infinite}
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}

  /* ── 数据卡 ── */
  .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:13px;margin-bottom:28px}
  .card{
    position:relative;padding:14px 17px;
    background:linear-gradient(160deg,rgba(22,32,46,.9),rgba(13,18,25,.92));
    border:1px solid var(--line);
    clip-path:polygon(0 0,calc(100% - 13px) 0,100% 13px,100% 100%,13px 100%,0 calc(100% - 13px));
    transition:border-color .22s,box-shadow .22s;
  }
  .card::before{
    content:"";position:absolute;top:0;left:0;width:2px;height:34%;
    background:var(--accent);box-shadow:0 0 9px var(--glow);transition:height .3s;
  }
  .card:hover{border-color:var(--line2);box-shadow:0 0 26px rgba(56,189,248,.12),inset 0 0 26px rgba(56,189,248,.04)}
  .card:hover::before{height:100%}
  .k{color:var(--fg3);font-size:10.5px;letter-spacing:1.6px;text-transform:uppercase}
  .v{font-size:17px;font-weight:700;margin-top:4px;word-break:break-word;letter-spacing:.4px}
  .ok{color:var(--ok);text-shadow:0 0 12px rgba(74,222,128,.5)}
  .bad{color:var(--bad);text-shadow:0 0 12px rgba(248,113,113,.5)}
  .warn{color:var(--warn);text-shadow:0 0 12px rgba(251,191,36,.45)}

  /* ── 分节标题 ── */
  h2{
    font-size:11.5px;color:var(--fg2);margin:0 0 13px;letter-spacing:2.6px;
    text-transform:uppercase;font-weight:600;display:flex;align-items:center;gap:10px;
  }
  h2::before{
    content:"";width:3px;height:13px;background:var(--accent);
    box-shadow:0 0 10px var(--glow);flex:none;
  }
  h2::after{content:"";flex:1;height:1px;
    background:linear-gradient(90deg,var(--line2),transparent 70%)}

  /* ── 面板容器 ── */
  .panel{
    position:relative;padding:17px 19px;margin-bottom:24px;
    background:linear-gradient(165deg,rgba(17,24,35,.92),rgba(10,14,20,.95));
    border:1px solid var(--line);
    clip-path:polygon(0 0,calc(100% - 17px) 0,100% 17px,100% 100%,17px 100%,0 calc(100% - 17px));
  }
  /* 四角 HUD 标记 */
  .panel::before,.panel::after{
    content:"";position:absolute;width:12px;height:12px;pointer-events:none;
    border-color:var(--accent);opacity:.55;
  }
  .panel::before{top:7px;right:7px;border-top:1.5px solid;border-right:1.5px solid}
  .panel::after{bottom:7px;left:7px;border-bottom:1.5px solid;border-left:1.5px solid}

  /* ── 情绪卡 ── */
  .moodbox{display:flex;gap:18px;flex-wrap:wrap}
  .moodcard{flex:1 1 300px;min-width:280px;
    background:linear-gradient(160deg,rgba(22,32,46,.75),rgba(13,18,25,.8));
    border:1px solid var(--line);border-left:2px solid var(--accent);
    padding:15px 17px}
  .moodtext{font-size:17px;line-height:1.55;margin:9px 0 12px;min-height:2.7em;word-break:break-word;font-weight:500;
    color:#dbeafe;text-shadow:0 0 22px rgba(56,189,248,.28)}
  .moodmeta{color:var(--fg3);font-size:11px;margin-top:11px;letter-spacing:.6px;font-family:ui-monospace,Consolas,monospace}
  .bar{height:8px;background:#0d141d;overflow:hidden;margin:9px 0 6px;position:relative;
    border:1px solid var(--line)}
  .bar>i{display:block;height:100%;background:linear-gradient(90deg,#f87171,#fbbf24,#4ade80);
    transition:width .5s cubic-bezier(.4,0,.2,1);box-shadow:0 0 14px currentColor}
  .bar::after{content:"";position:absolute;left:50%;top:0;bottom:0;width:1px;background:rgba(56,189,248,.35)}
  .scale{display:flex;justify-content:space-between;color:var(--fg3);font-size:10px;letter-spacing:1px}
  .intensity{margin-top:14px;border-top:1px solid var(--line);padding-top:12px}
  .intensity .k{margin-bottom:8px}
  .intensity b{color:var(--accent);font-size:18px;font-variant-numeric:tabular-nums;
    text-shadow:0 0 16px var(--glow)}
  .intensity .unit{color:var(--fg3);font-size:11px;margin-left:2px}
  .iseg{display:flex;gap:3px}
  .iseg>i{flex:1;height:10px;background:#0d141d;border:1px solid var(--line);
    transition:background .35s,box-shadow .35s}
  .iseg>i.on1{background:#4a6fa5;box-shadow:0 0 10px rgba(74,111,165,.7)}
  .iseg>i.on2{background:#4ade80;box-shadow:0 0 10px rgba(74,222,128,.65)}
  .iseg>i.on3{background:#fbbf24;box-shadow:0 0 10px rgba(251,191,36,.65)}
  .iseg>i.on4{background:#f59e0b;box-shadow:0 0 11px rgba(245,158,11,.7)}
  .iseg>i.on5{background:#f87171;box-shadow:0 0 13px rgba(248,113,113,.75)}
  .ilabel{color:var(--fg2);font-size:12px;margin-top:8px;min-height:1.4em}
  .chartcard{flex:2 1 440px;min-width:330px;
    background:linear-gradient(160deg,rgba(22,32,46,.75),rgba(13,18,25,.8));
    border:1px solid var(--line);padding:15px 17px}
  #chart{width:100%;height:158px;display:block}
  .chartlegend{color:var(--fg3);font-size:10.5px;margin-top:7px;letter-spacing:.6px}
  .chartlegend b{color:#e8823c;font-weight:500}
  .chartlegend i{color:#9aa6b8;font-style:normal}

  table{width:100%;border-collapse:separate;border-spacing:0}
  th{
    text-align:left;padding:8px 12px;font-size:10px;letter-spacing:1.7px;
    color:var(--fg3);font-weight:600;text-transform:uppercase;
    border-bottom:1px solid var(--line2);background:rgba(56,189,248,.03);
  }
  td{text-align:left;padding:10px 12px;border-bottom:1px solid #16202e;vertical-align:top;font-size:13px}
  tbody tr{transition:background .16s,box-shadow .16s}
  tbody tr:hover{background:rgba(56,189,248,.055);box-shadow:inset 2px 0 0 var(--accent)}
  tbody tr:last-child td{border-bottom:none}
  td.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;color:var(--fg2)}
  .tag{display:inline-block;padding:2px 9px;font-size:10.5px;letter-spacing:.5px;
    background:#141c27;color:var(--fg2);border:1px solid var(--line)}
  .tag.on{background:rgba(74,222,128,.1);color:var(--ok);border-color:rgba(74,222,128,.3);
    box-shadow:0 0 12px rgba(74,222,128,.14)}
  .tag.off{background:rgba(248,113,113,.09);color:var(--bad);border-color:rgba(248,113,113,.25)}
  .tag.mood{background:rgba(251,191,36,.09);color:var(--warn);border-color:rgba(251,191,36,.25)}
  .empty{color:var(--fg3);font-size:12.5px;padding:20px 11px;text-align:center;letter-spacing:1px}
  .trunc{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg2)}
  .scroll{max-height:420px;overflow:auto}
  .scroll::-webkit-scrollbar{width:7px}
  .scroll::-webkit-scrollbar-track{background:transparent}
  .scroll::-webkit-scrollbar-thumb{background:#24344a;border-radius:0}
  .scroll::-webkit-scrollbar-thumb:hover{background:var(--accent)}

  /* ── 情绪星图 ── */
  .starbox{display:flex;gap:22px;flex-wrap:wrap}
  .starcard{flex:1 1 340px;min-width:300px}
  #star{width:100%;height:300px;display:block}
  .starlabels{display:flex;flex-wrap:wrap;gap:7px 15px;margin-top:9px;font-size:11px;color:var(--fg2);letter-spacing:.5px}
  .starlabel{display:flex;align-items:center;gap:6px}
  .starlabel i{width:7px;height:7px;display:inline-block;box-shadow:0 0 8px currentColor}
  .starbar{margin-bottom:10px}
  .starbar .t{display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px}
  .starbar .t b{color:var(--fg);font-weight:600;letter-spacing:.5px}
  .starbar .t span{color:var(--fg3);font-variant-numeric:tabular-nums;font-family:ui-monospace,Consolas,monospace}
  .starbar .track{height:7px;background:#0d141d;border:1px solid var(--line);overflow:hidden}
  .starbar .fill{height:100%;transition:width .5s cubic-bezier(.4,0,.2,1);box-shadow:0 0 12px currentColor}
  .winrow{display:flex;gap:8px;flex-wrap:wrap}
  .winbtn{
    background:#111823;border:1px solid var(--line);color:var(--fg2);
    padding:7px 14px;font-size:11.5px;cursor:pointer;letter-spacing:.8px;
    transition:all .18s;font-family:inherit;text-transform:uppercase;
  }
  .winbtn:hover{border-color:var(--line2);color:var(--fg);box-shadow:0 0 14px rgba(56,189,248,.15)}
  .winbtn.on{background:rgba(56,189,248,.13);border-color:var(--accent);color:var(--accent);
    box-shadow:0 0 16px rgba(56,189,248,.28),inset 0 0 16px rgba(56,189,248,.07)}

  /* ── 记忆星系 ── */
  #people{width:100%;height:460px;display:block}
  .peoplelist{max-height:460px;overflow:auto}
  .plrow{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #16202e;
    transition:background .15s,box-shadow .15s}
  .plrow:hover{background:rgba(56,189,248,.05);box-shadow:inset 2px 0 0 var(--accent)}
  .plrow:last-child{border-bottom:none}
  .plrow .dot{width:8px;height:8px;border-radius:50%;flex:none;box-shadow:0 0 9px currentColor}
  .plrow .nm{flex:1;font-size:13px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .plrow .rel{font-size:10px;padding:2px 8px;border:1px solid transparent;flex:none;letter-spacing:.8px}
  .rel.owner{background:rgba(251,191,36,.13);color:#fbbf24;border-color:rgba(251,191,36,.35);box-shadow:0 0 12px rgba(251,191,36,.18)}
  .rel.admin{background:rgba(34,211,238,.12);color:#22d3ee;border-color:rgba(34,211,238,.3)}
  .rel.friend{background:rgba(74,222,128,.1);color:#4ade80;border-color:rgba(74,222,128,.25)}
  .rel.stranger{background:rgba(100,116,139,.12);color:#94a3b8;border-color:rgba(100,116,139,.25)}
  .plrow .bar2{width:54px;height:3px;background:#0d141d;overflow:hidden;flex:none;border:1px solid var(--line)}
  .plrow .bar2 i{display:block;height:100%;background:linear-gradient(90deg,#38bdf8,#f472b6);box-shadow:0 0 8px rgba(56,189,248,.5)}
  .gtag{font-size:9.5px;padding:1px 6px;border:1px solid #24344a;color:var(--fg3);flex:none;letter-spacing:.5px}

  /* ── 参数调节 ── */
  .tune{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}
  .tfield label{display:block;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:var(--fg3);margin-bottom:8px}
  .trow{display:flex;align-items:center;gap:12px}
  .trow b{color:var(--accent);font-size:15px;font-variant-numeric:tabular-nums;min-width:44px;
    text-align:right;text-shadow:0 0 14px var(--glow)}
  input[type=range]{
    flex:1;-webkit-appearance:none;appearance:none;height:4px;background:#0d141d;
    border:1px solid var(--line);outline:none;cursor:pointer;
  }
  input[type=range]::-webkit-slider-thumb{
    -webkit-appearance:none;width:13px;height:13px;background:var(--accent);
    box-shadow:0 0 12px var(--glow);cursor:pointer;border:1px solid #a5e4ff;
  }
  .thint{color:var(--fg3);font-size:10.5px;margin-top:6px;line-height:1.5}
  .tuneapply{display:flex;align-items:center;gap:14px;margin-top:18px;padding-top:16px;border-top:1px solid var(--line);flex-wrap:wrap}
  .applybtn{
    background:rgba(56,189,248,.13);border:1px solid var(--accent);color:var(--accent);
    padding:8px 22px;font-size:12px;letter-spacing:1.6px;text-transform:uppercase;
    cursor:pointer;font-family:inherit;transition:all .18s;
    box-shadow:0 0 16px rgba(56,189,248,.22),inset 0 0 16px rgba(56,189,248,.06);
  }
  .applybtn:hover{background:rgba(56,189,248,.22);box-shadow:0 0 24px rgba(56,189,248,.35)}
  .applybtn:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
  .tmsg{font-size:12px;color:var(--ok)}
  .tmsg.err{color:var(--bad)}
  .tfile{font-size:10.5px;color:var(--fg3);margin-left:auto;font-family:ui-monospace,Consolas,monospace}
  @media(max-width:640px){
    .wrap{padding:18px 14px 0}
    .trunc{max-width:180px}
    #chart{height:130px}
    #star{height:250px}
    #people{height:380px}
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">🐟</div>
    <div>
      <h1>QQ Kit</h1>
      <div class="sub">协议端 → DSH 适配层 · 每 2 秒刷新</div>
    </div>
    <div class="live"><span class="dot" id="liveDot"></span><span id="liveText">连接中…</span></div>
  </header>

  <div class="row" id="cards"></div>

  <h2>参数调节（改完立刻生效，不用重启）</h2>
  <div class="panel">
    <div class="tune">
      <div class="tfield">
        <label>主动插话频率</label>
        <div class="trow">
          <input type="range" id="tPerMin" min="0" max="6" step="0.5" value="1">
          <b id="tPerMinV">—</b>
        </div>
        <div class="thint">每群每分钟最多主动说几次（0 = 不限；被 @ 不受限）</div>
      </div>
      <div class="tfield">
        <label>总结频率</label>
        <div class="trow">
          <input type="range" id="tEvery" min="1" max="5" step="1" value="1">
          <b id="tEveryV">—</b>
        </div>
        <div class="thint">每几轮真跑一次总结（1 = 每轮都跑，情绪最鲜活；越大越省）</div>
      </div>
      <div class="tfield">
        <label>冷场抢跑</label>
        <div class="trow">
          <input type="range" id="tCold" min="5" max="180" step="5" value="30">
          <b id="tColdV">—</b>
        </div>
        <div class="thint">群里安静这么久后，下一句立刻触发（秒）</div>
      </div>
      <div class="tfield">
        <label>模式</label>
        <div class="trow">
          <button class="winbtn" id="tDry">真发</button>
        </div>
        <div class="thint">切到"只观察"就不会发消息，只打印计划</div>
      </div>
    </div>
    <div class="tuneapply">
      <button class="applybtn" id="tApply">应用</button>
      <span id="tMsg" class="tmsg"></span>
      <span class="tfile" id="tFile"></span>
    </div>
  </div>

  <h2>情绪监控</h2>
  <div class="panel">
    <div class="moodbox">
      <div class="moodcard">
        <div class="k">当前情绪</div>
        <div class="moodtext" id="moodNow">—</div>
        <div class="bar"><i id="moodBar" style="width:50%"></i></div>
        <div class="scale"><span>负面</span><span>中性</span><span>正面</span></div>
        <div class="intensity">
          <div class="k">强度 <b id="moodIntensity">0</b><span class="unit">/10</span></div>
          <div class="iseg" id="moodSegs"></div>
          <div class="ilabel" id="moodLabel">—</div>
        </div>
        <div class="moodmeta" id="moodMeta">还没有情绪记录</div>
      </div>
      <div class="chartcard">
        <div class="k">情绪走势 · 最近 200 个点</div>
        <canvas id="chart"></canvas>
        <div class="chartlegend"><i>实线</i> 极性（按词粗估）　<b>虚线</b> 强度 0-10</div>
      </div>
    </div>
  </div>

  <h2>工作区会话</h2>
  <div class="panel" style="padding:6px 8px 8px">
    <table><thead><tr><th>会话</th><th>路由</th><th>消息</th><th>最近一条</th><th>情绪</th><th>摘要</th></tr></thead>
    <tbody id="sessions"></tbody></table>
  </div>

  <h2>情绪星图</h2>
  <div class="panel">
    <div class="starbox">
      <div class="starcard">
        <canvas id="star"></canvas>
        <div class="starlabels" id="starLegend"></div>
      </div>
      <div class="starcard">
        <div class="k" style="margin-bottom:10px">各类占比</div>
        <div id="starBars"></div>
        <div class="k" style="margin:14px 0 8px">切换时间窗</div>
        <div class="winrow" id="starWindows">
          <button data-win="hour" class="winbtn">近 1 小时</button>
          <button data-win="day" class="winbtn on">近 24 小时</button>
          <button data-win="all" class="winbtn">全部</button>
        </div>
      </div>
    </div>
  </div>

  <h2>记忆星图</h2>
  <div class="panel">
    <div class="starbox">
      <div class="starcard">
        <canvas id="people"></canvas>
        <div class="starlabels" id="peopleLegend"></div>
      </div>
      <div class="starcard">
        <div class="k" style="margin-bottom:10px">她记得的人</div>
        <div id="peopleList" class="peoplelist"></div>
      </div>
    </div>
  </div>

  <h2>最近消息</h2>
  <div class="panel" style="padding:6px 8px 8px">
    <div class="scroll">
      <table><thead><tr><th>时间</th><th>会话</th><th>发送人</th><th>内容</th></tr></thead>
      <tbody id="recent"></tbody></table>
    </div>
  </div>
</div>

<script>
const fmtTime = (ms) => ms ? new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }) : '';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// 情绪极性：-1 负面 ~ 0 中性 ~ 1 正面，映射成进度条百分比
function barWidth(polarity) {
  const p = Math.max(-1, Math.min(1, Number(polarity) || 0));
  return Math.round((p + 1) / 2 * 100);
}

function renderMood(s) {
  const mh = s.moodHistory || { points: [], latest: null };
  const latest = mh.latest;
  const intensity = Math.max(0, Math.min(10, Math.round(Number(latest && latest.intensity) || 0)));
  document.getElementById('moodNow').textContent = latest && latest.mood ? latest.mood : '—';
  document.getElementById('moodBar').style.width = barWidth(latest ? latest.polarity : 0) + '%';

  // 强度：数字 + 10 格条 + 文字分档
  document.getElementById('moodIntensity').textContent = String(intensity);
  const segs = document.getElementById('moodSegs');
  if (segs) {
    // 每格代表 1 分；按档位上色，一眼看出是"有点"还是"上头"
    const tierOf = (n) => (n <= 2 ? 'on1' : n <= 4 ? 'on2' : n <= 6 ? 'on3' : n <= 8 ? 'on4' : 'on5');
    const tier = tierOf(intensity);
    let html = '';
    for (let i = 0; i < 10; i += 1) {
      // 注意：这段代码在模板字符串里，不能用反引号/美元花括号
      html += '<i class="' + (i < intensity ? tier : '') + '"></i>';
    }
    segs.innerHTML = html;
  }
  const labels = ['没有情绪', '几乎不影响', '很淡', '轻', '轻', '明显', '明显', '重', '重', '上头', '上头'];
  const labelEl = document.getElementById('moodLabel');
  if (labelEl) {
    // 同样避免在外层模板字符串里再套反引号
    labelEl.textContent = latest && latest.mood ? ('语气：' + (labels[intensity] || '—')) : '当前没有情绪';
  }

  const meta = latest
    ? (fmtTime(latest.at) + ' · ' + latest.sessionKey
       + ' · 极性 ' + (latest.polarity > 0 ? '+' : '') + Number(latest.polarity || 0).toFixed(2))
    : '还没有情绪记录';
  document.getElementById('moodMeta').textContent = meta;
  window.__lastMoodPoints = mh.points || [];
  drawChart(window.__lastMoodPoints);
}

// 极简折线图：不引依赖，按窗口大小重算
function drawChart(points) {
  const cv = document.getElementById('chart');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 420;
  const h = 150;
  cv.width = w * dpr;
  cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pad = 6;
  const midY = h / 2;
  // 中线和上下边界
  ctx.strokeStyle = '#2a2f38';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY); ctx.lineTo(w, midY);
  ctx.moveTo(0, pad); ctx.lineTo(w, pad);
  ctx.moveTo(0, h - pad); ctx.lineTo(w, h - pad);
  ctx.stroke();
  if (!points.length) {
    ctx.fillStyle = '#5c6675';
    ctx.font = '12px sans-serif';
    ctx.fillText('还没有数据', pad + 4, midY - 8);
    return;
  }
  const toX = (i) => points.length === 1 ? w / 2 : pad + (w - pad * 2) * (i / (points.length - 1));
  const toY = (p) => midY - Math.max(-1, Math.min(1, p)) * (midY - pad);
  // 面积填充
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(90,210,127,0.25)');
  grad.addColorStop(1, 'rgba(239,107,107,0.25)');
  ctx.beginPath();
  ctx.moveTo(toX(0), midY);
  points.forEach((p, i) => ctx.lineTo(toX(i), toY(p.polarity)));
  ctx.lineTo(toX(points.length - 1), midY);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  // 折线：极性（实线）
  ctx.beginPath();
  points.forEach((p, i) => { const x = toX(i), y = toY(p.polarity); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = '#9aa6b8';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 强度（虚线，0-10 映射到整张图的上下）：跟极性叠在一起，能看出"不爽但情绪不重"
  ctx.beginPath();
  ctx.setLineDash([4, 3]);
  points.forEach((p, i) => {
    const raw = Math.max(0, Math.min(10, Number(p.intensity) || 0));
    // 强度 0 贴底，10 贴顶；跟极性共用坐标系，方便对比
    const y = h - pad - (raw / 10) * (h - pad * 2);
    const x = toX(i);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = 'rgba(232,130,60,0.85)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.setLineDash([]);
}

// ── 情绪星图 ──────────────────────────────────────────────
// 8 个维度画成雷达图：半径 = 该类别占比（按最大值归一化，否则小比例看不见）
const STAR_COLORS = {
  开心: '#fbbf24', 好奇: '#60a5fa', 烦: '#f87171', 亲近: '#f472b6',
  疲惫: '#a78bfa', 得意: '#34d399', 尴尬: '#94a3b8', 平静: '#4b5563',
};
let starWindow = 'day';
let starData = null;

function renderStars(s) {
  const stats = s.moodStats;
  if (!stats) return;
  starData = stats[starWindow] || stats.day;
  if (!starData) return;

  const classes = Object.keys(starData.ratio || {});
  const maxR = Math.max(...classes.map((c) => starData.ratio[c] || 0), 0.0001);

  // 雷达图
  const cv = document.getElementById('star');
  if (cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 340;
    const h = 300;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 42;
    const n = classes.length;

    // 网格：3 圈
    g.strokeStyle = '#252d3a';
    g.lineWidth = 1;
    for (const frac of [0.33, 0.66, 1]) {
      g.beginPath();
      for (let i = 0; i <= n; i += 1) {
        const a = (Math.PI * 2 * i) / n - Math.PI / 2;
        const x = cx + Math.cos(a) * R * frac;
        const y = cy + Math.sin(a) * R * frac;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
    // 轴线
    g.beginPath();
    for (let i = 0; i < n; i += 1) {
      const a = (Math.PI * 2 * i) / n - Math.PI / 2;
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    }
    g.stroke();

    // 数据多边形（归一化到最大值）
    g.beginPath();
    for (let i = 0; i <= n; i += 1) {
      const idx = i % n;
      const cls = classes[idx];
      const val = (starData.ratio[cls] || 0) / maxR;
      const a = (Math.PI * 2 * idx) / n - Math.PI / 2;
      const x = cx + Math.cos(a) * R * val;
      const y = cy + Math.sin(a) * R * val;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath();
    g.fillStyle = 'rgba(96,165,250,0.22)';
    g.fill();
    g.strokeStyle = 'rgba(96,165,250,0.9)';
    g.lineWidth = 2;
    g.stroke();

    // 顶点小圆
    for (let i = 0; i < n; i += 1) {
      const cls = classes[i];
      const val = (starData.ratio[cls] || 0) / maxR;
      const a = (Math.PI * 2 * i) / n - Math.PI / 2;
      const x = cx + Math.cos(a) * R * val;
      const y = cy + Math.sin(a) * R * val;
      g.beginPath();
      g.arc(x, y, 3.2, 0, Math.PI * 2);
      g.fillStyle = STAR_COLORS[cls] || '#9aa6b8';
      g.fill();
    }

    // 轴标签
    g.font = '12px ui-sans-serif,system-ui,sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < n; i += 1) {
      const cls = classes[i];
      const a = (Math.PI * 2 * i) / n - Math.PI / 2;
      const x = cx + Math.cos(a) * (R + 24);
      const y = cy + Math.sin(a) * (R + 24);
      g.fillStyle = STAR_COLORS[cls] || '#9aa6b8';
      g.fillText(cls, x, y);
    }
  }

  // 图例
  const legend = document.getElementById('starLegend');
  if (legend) {
    legend.innerHTML = classes
      .map((c) => '<span class="starlabel"><i style="background:' + (STAR_COLORS[c] || '#9aa6b8') + '"></i>' + c + '</span>')
      .join('');
  }

  // 占比条
  const bars = document.getElementById('starBars');
  if (bars) {
    bars.innerHTML = classes
      .slice()
      .sort((a, b) => (starData.ratio[b] || 0) - (starData.ratio[a] || 0))
      .map((c) => {
        const pct = ((starData.ratio[c] || 0) * 100).toFixed(1);
        const col = STAR_COLORS[c] || '#9aa6b8';
        return '<div class="starbar"><div class="t"><b>' + c + '</b><span>' + pct + '%</span></div>' +
          '<div class="track"><div class="fill" style="width:' + Math.max(1, Number(pct)) + '%;background:' + col + '"></div></div></div>';
      })
      .join('');
  }
}

// ── 记忆星系：她跟每个人的关系，力导向 + 科技风 ─────────────
//
// 参考那种"模组依赖图"的形态：中心一个核心，节点向外散开，连线带箭头。
// 算法要点：
//   - 力导向：节点之间互相排斥、跟中心有引力、连线有弹簧；
//   - 每帧衰减一点温度（见底后停），不再动 —— 省 CPU，也避免一直抖。
const REL_COLORS = { owner: '#fbbf24', admin: '#22d3ee', friend: '#4ade80', stranger: '#64748b' };
const REL_NAMES = { owner: '主人', admin: '管理', friend: '熟人', stranger: '陌生' };
/** 不同群的配色：同一张图上能看出"这批人是哪个群的" */
const GROUP_COLORS = ['#38bdf8', '#a78bfa', '#fb923c', '#4ade80', '#f472b6'];

/** 星系状态：布局只算一次，之后复用位置（除非人数变了） */
let gal = null;

function galaxyLayout(nodes, w, h) {
  // 首次：把服务端给的圆环初值放到画布中心
  const cx = w / 2;
  const cy = h / 2;
  const K = Math.min(w, h) * 0.42; // 缩放
  const pts = nodes.map((n, i) => ({
    ...n,
    x: cx + (Number.isFinite(n.x) ? n.x : Math.cos((i / nodes.length) * Math.PI * 2)) * K * 0.6,
    y: cy + (Number.isFinite(n.y) ? n.y : Math.sin((i / nodes.length) * Math.PI * 2)) * K * 0.6,
    vx: 0,
    vy: 0,
  }));
  const ctr = { x: cx, y: cy };
  let temp = 1; // 温度：模拟退火，越高动得越猛
  // 迭代 260 步足够稳定（节点数只有十几个）
  for (let step = 0; step < 260; step += 1) {
    // 节点互斥
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        let dx = pts[i].x - pts[j].x;
        let dy = pts[i].y - pts[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { d2 = 1; dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
        const d = Math.sqrt(d2);
        // 排斥力：越近越猛；亲近度高的反而靠得近一点（除以 warm+0.5）
        const rep = (2200 / d2) * (0.6 + (1 - pts[i].warmth) * 0.8);
        const fx = (dx / d) * rep;
        const fy = (dy / d) * rep;
        pts[i].vx += fx; pts[i].vy += fy;
        pts[j].vx -= fx; pts[j].vy -= fy;
      }
    }
    // 中心引力 + 弹簧（沿连线方向拉）
    for (const p of pts) {
      const dx = ctr.x - p.x;
      const dy = ctr.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      // 目标半径：亲近的靠近核心，疏远的甩到外圈
      const target = K * (0.42 + (1 - p.warmth) * 0.55);
      const pull = (d - target) * 0.012;
      p.vx += (dx / d) * pull;
      p.vy += (dy / d) * pull;
    }
    // 应用速度（带温度衰减）
    for (const p of pts) {
      const lim = 12 * temp;
      const v = Math.hypot(p.vx, p.vy) || 1;
      const scale = Math.min(1, lim / v);
      p.x += p.vx * scale * 0.55;
      p.y += p.vy * scale * 0.55;
      p.vx *= 0.35;
      p.vy *= 0.35;
      // 别跑出画布
      p.x = Math.max(46, Math.min(w - 46, p.x));
      p.y = Math.max(28, Math.min(h - 28, p.y));
    }
    temp *= 0.985;
  }
  return pts;
}

function drawGalaxy(nodes, w, h) {
  const cv = document.getElementById('people');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = w * dpr;
  cv.height = h * dpr;
  const g = cv.getContext('2d');

  // 群号 → 配色下标（同群同色，不同群不同色）
  const groupIdx = {};
  let gi = 0;
  for (const p of nodes) {
    if (!(p.group in groupIdx)) groupIdx[p.group] = gi++;
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;

  // 背景网格（科技感）
  g.strokeStyle = 'rgba(96,165,250,0.06)';
  g.lineWidth = 1;
  for (let x = 0; x < w; x += 34) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = 0; y < h; y += 34) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }

  // 同心圆
  for (const r of [0.3, 0.55, 0.8]) {
    g.beginPath();
    g.arc(cx, cy, Math.min(w, h) * r * 0.52, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(96,165,250,0.07)';
    g.stroke();
  }

  if (!nodes.length) {
    g.fillStyle = 'rgba(148,163,184,.55)';
    g.font = '12px ui-sans-serif,system-ui,sans-serif';
    g.textAlign = 'center';
    g.fillText('还没记住任何人', cx, cy);
    // 空态也画个核心
    drawCore(g, cx, cy);
    return;
  }

  const pts = gal ? gal.pts : galaxyLayout(nodes, w, h);

  // 连线：带箭头，粗细 = 亲近度
  pts.forEach((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const startX = cx + ux * 22;
    const startY = cy + uy * 22;
    const endX = p.x - ux * 14;
    const endY = p.y - uy * 14;
    // 群色优先（能一眼分出哪个群的人），主人除外 —— 主人要一直最扎眼
    const col = p.relation === 'owner' ? REL_COLORS.owner : (GROUP_COLORS[groupIdx[p.group] ?? 0] || REL_COLORS[p.relation] || '#64748b');

    // 渐变线：靠近核心偏蓝，靠近人偏自己的颜色
    const lg = g.createLinearGradient(startX, startY, endX, endY);
    lg.addColorStop(0, 'rgba(96,165,250,0.55)');
    lg.addColorStop(1, col.replace(')', '').replace('rgb', 'rgba') === col ? col : col);
    g.beginPath();
    g.moveTo(startX, startY);
    g.lineTo(endX, endY);
    g.strokeStyle = col;
    g.globalAlpha = 0.22 + p.warmth * 0.55;
    g.lineWidth = 0.8 + p.warmth * 2.2;
    g.stroke();
    g.globalAlpha = 1;

    // 箭头
    const ang = Math.atan2(uy, ux);
    const ah = 6 + p.warmth * 3;
    g.beginPath();
    g.moveTo(endX, endY);
    g.lineTo(endX - ah * Math.cos(ang - 0.4), endY - ah * Math.sin(ang - 0.4));
    g.lineTo(endX - ah * Math.cos(ang + 0.4), endY - ah * Math.sin(ang + 0.4));
    g.closePath();
    g.fillStyle = col;
    g.globalAlpha = 0.35 + p.warmth * 0.5;
    g.fill();
    g.globalAlpha = 1;
  });

  // 人：光点 + 名字
  pts.forEach((p) => {
    // 群色优先（能一眼分出哪个群的人），主人除外 —— 主人要一直最扎眼
    const col = p.relation === 'owner' ? REL_COLORS.owner : (GROUP_COLORS[groupIdx[p.group] ?? 0] || REL_COLORS[p.relation] || '#64748b');
    const r = 5 + p.warmth * 6;

    // 光晕
    const halo = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.6);
    halo.addColorStop(0, col + '55');
    halo.addColorStop(1, col + '00');
    g.beginPath();
    g.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2);
    g.fillStyle = halo;
    g.fill();

    // 本体
    g.beginPath();
    g.arc(p.x, p.y, r, 0, Math.PI * 2);
    g.fillStyle = col;
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,.35)';
    g.lineWidth = 1;
    g.stroke();

    // 名字：白字 + 深色描边，保证在任何背景上都看得清
    const label = p.name.length > 9 ? p.name.slice(0, 9) + '…' : p.name;
    g.font = '600 11.5px ui-sans-serif,system-ui,sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(10,14,20,.9)';
    g.strokeText(label, p.x, p.y + r + 5);
    g.fillStyle = '#e8edf5';
    g.fillText(label, p.x, p.y + r + 5);
  });

  drawCore(g, cx, cy);
}

function drawCore(g, cx, cy) {
  // 核心：呼吸光球
  const hal = g.createRadialGradient(cx, cy, 0, cx, cy, 46);
  hal.addColorStop(0, 'rgba(96,165,250,.5)');
  hal.addColorStop(1, 'rgba(96,165,250,0)');
  g.beginPath();
  g.arc(cx, cy, 46, 0, Math.PI * 2);
  g.fillStyle = hal;
  g.fill();

  const core = g.createRadialGradient(cx - 5, cy - 5, 2, cx, cy, 20);
  core.addColorStop(0, '#93c5fd');
  core.addColorStop(1, '#2563eb');
  g.beginPath();
  g.arc(cx, cy, 17, 0, Math.PI * 2);
  g.fillStyle = core;
  g.fill();
  g.strokeStyle = 'rgba(147,197,253,.55)';
  g.lineWidth = 2;
  g.stroke();

  g.fillStyle = '#fff';
  g.font = '600 12px ui-sans-serif,system-ui,sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('鱼', cx, cy);
}

function renderPeople(s) {
  const people = s.people;
  if (!people) return;
  const nodes = people.nodes || [];

  const cv = document.getElementById('people');
  if (cv) {
    const w = cv.clientWidth || 520;
    const h = 460;
    // 人数变了就重算布局；否则复用（避免每次刷新都重排、视觉上跳）
    if (!gal || gal.key !== String(nodes.length)) {
      gal = { key: String(nodes.length), pts: galaxyLayout(nodes, w, h) };
    }
    drawGalaxy(nodes, w, h);
  }

  // 图例：关系类型 + 群来源
  const legend = document.getElementById('peopleLegend');
  if (legend) {
    const sm = people.summary || {};
    const relPart = Object.keys(REL_NAMES)
      .filter((k) => (sm[k] || 0) > 0)
      .map((k) => '<span class="starlabel"><i style="background:' + REL_COLORS[k] + '"></i>' + REL_NAMES[k] + ' ' + sm[k] + '</span>')
      .join('');
    // 群图例：每个群一个色块
    const gIdx = {};
    let gi = 0;
    for (const p of nodes) if (!(p.group in gIdx)) gIdx[p.group] = gi++;
    const groupPart = Object.keys(gIdx)
      .map((g) => '<span class="starlabel"><i style="background:' + GROUP_COLORS[gIdx[g] % GROUP_COLORS.length] + '"></i>群 ' + g + '</span>')
      .join('');
    legend.innerHTML = relPart + (groupPart ? '<span style="width:1px;height:12px;background:#24344a;display:inline-block;margin:0 4px"></span>' + groupPart : '');
  }

  // 名单
  const list = document.getElementById('peopleList');
  if (list) {
    list.innerHTML = nodes.length
      ? nodes
          .map((p) => {
            const gs = p.groups || (p.group ? [p.group] : []);
            // 同一个人的群归属：1 个群不提，多个群标个"2 群"
            const gTag = gs.length > 1 ? '<span class="gtag" title="' + esc(gs.join('、')) + '">' + gs.length + ' 群</span>' : '';
            return (
              '<div class="plrow">' +
              '<span class="dot" style="background:' + (REL_COLORS[p.relation] || '#64748b') + '"></span>' +
              '<span class="nm" title="' + esc(p.note) + '">' + esc(p.name) + '</span>' +
              gTag +
              '<span class="bar2"><i style="width:' + Math.round(p.warmth * 100) + '%"></i></span>' +
              '<span class="rel ' + p.relation + '">' + (REL_NAMES[p.relation] || p.relation) + '</span>' +
              '</div>'
            );
          })
          .join('')
      : '<div class="empty">还没有人名记忆</div>';
  }
}

// ── 参数调节（热更新）─────────────────────────────────────
// 滑块改完点"应用"，POST 到 /qq-kit/api/tune，后端写进 qq-kit-live.json 并立刻生效。
let tuneDry = false;
let tuneDirty = false;

function renderTune(s) {
  const c = s.config || {};
  const merge = c.merge || {};
  const fileEl = document.getElementById('tFile');
  if (fileEl) fileEl.textContent = s.liveConfigFile || '（未配置热更新文件）';

  // 只有用户没动过的控件才跟着服务端刷新，避免一边拖一边被覆盖
  if (!tuneDirty) {
    const pm = document.getElementById('tPerMin');
    const ev = document.getElementById('tEvery');
    const cd = document.getElementById('tCold');
    if (pm && typeof merge.perMinute === 'number') {
      pm.value = String(merge.perMinute);
      document.getElementById('tPerMinV').textContent = merge.perMinute === 0 ? '不限' : merge.perMinute + '/分';
    }
    if (ev && typeof c.summarizeEvery === 'number') {
      ev.value = String(c.summarizeEvery);
      document.getElementById('tEveryV').textContent = c.summarizeEvery === 1 ? '每轮' : '每 ' + c.summarizeEvery + ' 轮';
    }
    if (cd && typeof c.coldSilenceMs === 'number') {
      const sec = Math.round(c.coldSilenceMs / 1000);
      cd.value = String(sec);
      document.getElementById('tColdV').textContent = sec + 's';
    }
    tuneDry = Boolean(c.dryRun);
  }
  const dryBtn = document.getElementById('tDry');
  if (dryBtn) {
    dryBtn.textContent = tuneDry ? '只观察（不发）' : '真发';
    dryBtn.classList.toggle('on', !tuneDry);
  }
}

// 滑块实时显示
['tPerMin', 'tEvery', 'tCold'].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => {
    tuneDirty = true;
    const v = Number(el.value);
    const out = document.getElementById(id + 'V');
    if (id === 'tPerMin') out.textContent = v === 0 ? '不限' : v + '/分';
    if (id === 'tEvery') out.textContent = v === 1 ? '每轮' : '每 ' + v + ' 轮';
    if (id === 'tCold') out.textContent = v + 's';
  });
});

const dryBtn = document.getElementById('tDry');
if (dryBtn) {
  dryBtn.addEventListener('click', () => {
    tuneDry = !tuneDry;
    tuneDirty = true;
    dryBtn.textContent = tuneDry ? '只观察（不发）' : '真发';
    dryBtn.classList.toggle('on', !tuneDry);
  });
}

const applyBtn = document.getElementById('tApply');
if (applyBtn) {
  applyBtn.addEventListener('click', async () => {
    const msg = document.getElementById('tMsg');
    applyBtn.disabled = true;
    msg.textContent = '应用中…';
    msg.classList.remove('err');
    const patch = {
      dryRun: tuneDry,
      summarizeEvery: Number(document.getElementById('tEvery').value),
      coldSilenceMs: Number(document.getElementById('tCold').value) * 1000,
      merge: { perMinute: Number(document.getElementById('tPerMin').value) },
    };
    try {
      const r = await fetch('/qq-kit/api/tune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status);
      msg.textContent = '已生效';
      tuneDirty = false;
      setTimeout(() => { msg.textContent = ''; }, 2500);
    } catch (e) {
      msg.textContent = '失败：' + e.message;
      msg.classList.add('err');
    } finally {
      applyBtn.disabled = false;
    }
  });
}

// 时间窗切换
document.querySelectorAll('.winbtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    starWindow = btn.getAttribute('data-win');
    document.querySelectorAll('.winbtn').forEach((b) => b.classList.toggle('on', b === btn));
    if (starData) renderStars({ moodStats: window.__moodStats || {} });
    // 重新取一次数据，让渲染用新的窗口
    tick();
  });
});

async function tick() {
  let s;
  try {
    // 必须用绝对路径：面板挂在 /qq-kit 下，页面地址结尾没斜杠时，
    // './api/state' 会被解析成 /api/state（少了 /qq-kit 前缀），正好撞上 DSH 的受保护接口 -> 401
    const r = await fetch('/qq-kit/api/state', { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) {
      // 网关没放行时 body 不是 JSON（比如 unauthorized），别让解析错误盖住真正的原因
      const body = await r.text().catch(() => '');
      throw new Error('HTTP ' + r.status + (body ? '：' + body.slice(0, 120) : ''));
    }
    s = await r.json();
  } catch (e) {
    document.getElementById('cards').innerHTML =
      '<div class="card"><div class="k">取数据失败</div><div class="v bad">' + esc(e.message) + '</div></div>';
    return;
  }

  renderMood(s);
  renderStars(s);
  renderPeople(s);
  renderTune(s);

  const conn = s.connection?.connected;
  // 顶部连接指示灯
  const dot = document.getElementById('liveDot');
  const liveText = document.getElementById('liveText');
  if (dot) dot.className = 'dot' + (conn ? ' on' : '');
  if (liveText) liveText.textContent = conn ? '已连接' : '未连接';

  document.getElementById('cards').innerHTML = [
    ['连接', conn ? '<span class="ok">已连接</span>' : '<span class="bad">未连接</span>', s.connection?.url],
    ['适配器', esc(s.config?.adapter), 'v' + esc(s.config?.version)],
    ['模式', s.config?.dryRun ? '<span class="warn">只观察</span>' : '<span class="ok">真发</span>', ''],
    ['会话数', s.sessions?.length ?? 0, ''],
    ['情绪点', (s.moodHistory?.points?.length ?? 0), '面板走势用'],
  ].map(([k, v, sub]) =>
    '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div>' +
    (sub ? '<div class="k">' + esc(sub) + '</div>' : '') + '</div>'
  ).join('');

  const sess = s.sessions ?? [];
  document.getElementById('sessions').innerHTML = sess.length
    ? sess.map(x => {
        const mood = (x.mood || '').slice(0, 60);
        return '<tr><td class="mono">' + esc(x.key) + '</td>' +
        '<td>' + (x.routed ? '<span class="tag on">已配</span>' : '<span class="tag off">无</span>') + '</td>' +
        '<td>' + x.count + '</td>' +
        '<td>' + esc(x.lastSender) + (x.lastAt ? ' <span class="k">' + fmtTime(x.lastAt) + '</span>' : '') +
          '<div class="trunc">' + esc(x.lastText) + '</div></td>' +
        '<td>' + (mood ? '<span class="tag mood">' + esc(mood) + '</span>' : '<span class="k">—</span>') + '</td>' +
        '<td class="trunc">' + esc((x.summary || '').slice(0, 160)) + '</td></tr>';
      }).join('')
    : '<tr><td colspan="6" class="empty">还没有会话。等群里来消息，或检查连接。</td></tr>';

  const recent = s.recent ?? [];
  document.getElementById('recent').innerHTML = recent.length
    ? recent.map(m =>
        '<tr><td class="mono">' + fmtTime(m.time) + '</td>' +
        '<td class="mono">' + esc(m.key) + '</td>' +
        '<td>' + esc(m.sender) + '</td>' +
        '<td class="trunc' + '">' + esc(m.text) + '</td></tr>')
    : '<tr><td colspan="4" class="empty">暂无消息</td></tr>';
}

tick();
setInterval(tick, 2000);
window.addEventListener('resize', () => {
  const el = document.getElementById('moodNow');
  if (el) drawChart((window.__lastMoodPoints || []));
});
</script>
</body>
</html>`;
}