/**
 * mood-kit 面板：情绪星图 + 人物星系。
 *
 * 独立于任何聊天插件 —— 数据来自 mood-kit 自己的 API，
 * 任何把情绪喂进来的插件都能用同一个面板看到结果。
 */

/**
 * 面板要用的完整状态快照。
 * @param {{
 *   state: ReturnType<import('./core.js').createMoodState>,
 *   memoryDir?: string,
 *   version?: string,
 *   chatIds?: string[],
 *   contributions?: Record<string, any>,
 * }} deps
 */
export function collectPanelState(deps) {
  const { state, memoryDir, version, chatIds = [], contributions = {}, stale = [] } = deps;
  const points = state.points();
  const people = state.people({ memoryDir, chatIds });
  return {
    version: version ?? '',
    moodHistory: {
      points,
      latest: points.length ? points[points.length - 1] : null,
      // 历史累计（含被上限裁掉的）——「情绪点」那张卡用它。
      // 用 points.length 的话，一到上限就永远显示 2000，看着像卡住。
      total: typeof state.total === 'function' ? state.total() : points.length,
    },
    moodStats: state.stats(),
    people,
    // 别的插件贡献的区块（qq-kit 会放 会话/消息/参数）
    contributions,
    // 磁盘上的代码比进程里的新 → 面板顶部会提示"改了没重启"
    stale: Array.isArray(stale) ? stale : [],
  };
}

/** 面板页 HTML。 */
export function renderPanelHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mood Kit · 情绪与关系</title>
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
  /* 透明模式：嵌进 DSH 主界面时让宿主背景完全透过来（?transparent=1 或 iframe 嵌入时自动开启）
   *
   * 注意：这一整块放在 body 规则**之后**，因为 CSS 里同权重的后写规则会赢；
   * 之前把它写在前面，body 的深色背景又把透明盖回去了。
   * 想要看得清一点就把下面几个 rgba 的 alpha 往上调。 */
  html{background:transparent}
  body{
    margin:0;padding:0 0 48px;position:relative;overflow-x:hidden;
    font:14px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background:
      radial-gradient(1400px 700px at 8% -12%, #10233a 0%, transparent 55%),
      radial-gradient(1000px 560px at 108% 6%, #0d2a2a 0%, transparent 50%),
      var(--bg);
    color:var(--fg);-webkit-font-smoothing:antialiased;
  }
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

  /* ── 透明模式覆盖（必须排在 body / body::before / body::after 之后）── */
  html.bare, html.bare body{background:transparent !important}
  html.bare body::before, html.bare body::after{display:none !important}
  html.bare .panel{
    background:rgba(13,18,25,.22) !important;
    backdrop-filter:blur(6px) saturate(1.15);
    -webkit-backdrop-filter:blur(6px) saturate(1.15);
  }
  html.bare .moodcard, html.bare .chartcard, html.bare .statcard,
  html.bare .starcard, html.bare .tunebox{
    background:rgba(17,24,35,.18) !important;
  }
  /* 其它带深色底的块也透掉（会话表、消息表、贡献区块） */
  html.bare .peoplelist, html.bare .extscroll, html.bare .tunegrid{background:transparent !important}
  /* 面板里的深色底元素（表格行、输入框轨道、进度条底）也一并透掉。
   *
   * ⚠️ 强度格子要排除在外：它靠 .on1~.on5 的背景色表示"点亮了几格"，
   * 连点亮的那几格一起透掉的话，强度条就只剩描边、看不出数值（踩过）。 */
  html.bare .bar, html.bare .track,
  html.bare .plrow .bar2, html.bare input[type=range],
  html.bare td, html.bare th{background-color:transparent !important}
  /* 只有"没点亮"的格子透掉，点亮的那几格保留颜色和发光 */
  html.bare .iseg>i:not(.on1):not(.on2):not(.on3):not(.on4):not(.on5){
    background-color:transparent !important;
  }
  html.bare .iseg>i.on1, html.bare .iseg>i.on2, html.bare .iseg>i.on3,
  html.bare .iseg>i.on4, html.bare .iseg>i.on5{opacity:1}
  html.bare .panel::before, html.bare .panel::after{opacity:.35}

  .wrap{max-width:1240px;margin:0 auto;padding:26px 24px 0;position:relative;z-index:1}
  header{display:flex;align-items:center;gap:15px;margin-bottom:24px;flex-wrap:wrap;
    padding-bottom:18px;border-bottom:1px solid var(--line);position:relative}
  header::after{content:"";position:absolute;left:0;bottom:-1px;width:180px;height:2px;
    background:linear-gradient(90deg,var(--accent),transparent);box-shadow:0 0 10px var(--glow)}
  .logo{
    width:42px;height:42px;flex:none;font-size:21px;
    background:linear-gradient(135deg,#0ea5e9,#22d3ee 60%,#a78bfa);
    display:flex;align-items:center;justify-content:center;
    clip-path:polygon(22% 0,100% 0,100% 78%,78% 100%,0 100%,0 22%);
    box-shadow:0 0 26px rgba(56,189,248,.4);
  }
  h1{font-size:20px;margin:0;letter-spacing:1.6px;font-weight:700;
    background:linear-gradient(90deg,#e8f0fa,#7dd3fc);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .sub{color:var(--fg3);font-size:11px;margin:3px 0 0;letter-spacing:2.2px;text-transform:uppercase}
  .live{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:11.5px;
    color:var(--fg2);letter-spacing:1.2px;text-transform:uppercase;
    background:rgba(17,24,35,.85);border:1px solid var(--line2);padding:7px 15px;
    box-shadow:inset 0 0 18px rgba(56,189,248,.07)}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--bad);box-shadow:0 0 10px var(--bad)}
  .dot.on{background:var(--ok);box-shadow:0 0 12px var(--ok);animation:pulse 1.8s infinite}
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}

  /* 代码过期提示条：改了源码但没重启 DSH */
  .stalebar{
    display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 20px;
    padding:11px 16px;font-size:12.5px;color:#fde68a;
    background:rgba(120,53,15,.28);border:1px solid rgba(251,191,36,.4);
    border-left:3px solid var(--warn);
  }
  .stalebar[hidden]{display:none}
  .stalebar b{color:#fcd34d}
  .staleicon{font-size:15px;line-height:1;color:var(--warn)}
  .stalebar code{
    font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#fbbf24;
    background:rgba(0,0,0,.28);padding:2px 7px;
  }
  html.bare .stalebar{background:rgba(120,53,15,.2);backdrop-filter:blur(6px)}

  h2{font-size:11.5px;color:var(--fg2);margin:0 0 13px;letter-spacing:2.6px;
    text-transform:uppercase;font-weight:600;display:flex;align-items:center;gap:10px}
  h2::before{content:"";width:3px;height:13px;background:var(--accent);
    box-shadow:0 0 10px var(--glow);flex:none}
  h2::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--line2),transparent 70%)}

  .panel{position:relative;padding:17px 19px;margin-bottom:24px;
    background:linear-gradient(165deg,rgba(17,24,35,.92),rgba(10,14,20,.95));
    border:1px solid var(--line);
    clip-path:polygon(0 0,calc(100% - 17px) 0,100% 17px,100% 100%,17px 100%,0 calc(100% - 17px))}
  .panel::before,.panel::after{content:"";position:absolute;width:12px;height:12px;
    pointer-events:none;border-color:var(--accent);opacity:.55}
  .panel::before{top:7px;right:7px;border-top:1.5px solid;border-right:1.5px solid}
  .panel::after{bottom:7px;left:7px;border-bottom:1.5px solid;border-left:1.5px solid}

  .k{color:var(--fg3);font-size:10.5px;letter-spacing:1.6px;text-transform:uppercase}

  /* 顶部统计卡片：横向铺开（之前漏了 .row 的 flex，三张卡竖着排占满一屏） */
  .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:24px}
  .statcard{
    background:linear-gradient(160deg,rgba(22,32,46,.9),rgba(13,18,25,.92));
    border:1px solid var(--line);padding:13px 16px;
    clip-path:polygon(0 0,calc(100% - 13px) 0,100% 13px,100% 100%,13px 100%,0 calc(100% - 13px));
  }
  .statcard .v{font-size:17px;font-weight:700;margin-top:4px;color:var(--fg)}
  html.bare .statcard{background:rgba(13,18,25,.22);backdrop-filter:blur(6px)}
  .moodbox{display:flex;gap:18px;flex-wrap:wrap}
  .moodcard{flex:1 1 300px;min-width:280px;
    background:linear-gradient(160deg,rgba(22,32,46,.75),rgba(13,18,25,.8));
    border:1px solid var(--line);border-left:2px solid var(--accent);padding:15px 17px}
  .moodtext{font-size:17px;line-height:1.55;margin:9px 0 12px;min-height:2.7em;word-break:break-word;
    font-weight:500;color:#dbeafe;text-shadow:0 0 22px rgba(56,189,248,.28)}
  .moodmeta{color:var(--fg3);font-size:11px;margin-top:11px;letter-spacing:.6px;
    font-family:ui-monospace,Consolas,monospace}
  .bar{height:8px;background:#0d141d;overflow:hidden;margin:9px 0 6px;position:relative;border:1px solid var(--line)}
  .bar>i{display:block;height:100%;background:linear-gradient(90deg,#f87171,#fbbf24,#4ade80);
    transition:width .5s cubic-bezier(.4,0,.2,1)}
  .bar::after{content:"";position:absolute;left:50%;top:0;bottom:0;width:1px;background:rgba(56,189,248,.35)}
  .scale{display:flex;justify-content:space-between;color:var(--fg3);font-size:10px;letter-spacing:1px}
  .intensity{margin-top:14px;border-top:1px solid var(--line);padding-top:12px}
  .intensity .k{margin-bottom:8px}
  .intensity b{color:var(--accent);font-size:18px;font-variant-numeric:tabular-nums;
    text-shadow:0 0 16px var(--glow)}
  .intensity .unit{color:var(--fg3);font-size:11px;margin-left:2px}
  .iseg{display:flex;gap:3px}
  .iseg>i{flex:1;height:12px;background:#0d141d;border:1px solid var(--line);
    transition:background .35s,box-shadow .35s}
  /* 强度分档配色：1-2 冷蓝、3-4 绿、5-6 黄、7-8 橙、9-10 红。
   * 蓝色那档之前用 #4a6fa5，配深色底几乎看不出亮，调成更亮的青蓝。 */
  .iseg>i.on1{background:#38bdf8;box-shadow:0 0 10px rgba(56,189,248,.8)}
  .iseg>i.on2{background:#4ade80;box-shadow:0 0 10px rgba(74,222,128,.75)}
  .iseg>i.on3{background:#fbbf24;box-shadow:0 0 11px rgba(251,191,36,.75)}
  .iseg>i.on4{background:#fb923c;box-shadow:0 0 12px rgba(251,146,60,.8)}
  .iseg>i.on5{background:#f87171;box-shadow:0 0 14px rgba(248,113,113,.85)}
  .ilabel{color:var(--fg2);font-size:12px;margin-top:8px;min-height:1.4em}
  .chartcard{flex:2 1 440px;min-width:330px;
    background:linear-gradient(160deg,rgba(22,32,46,.75),rgba(13,18,25,.8));
    border:1px solid var(--line);padding:15px 17px}
  #chart{width:100%;height:158px;display:block}
  .chartlegend{color:var(--fg3);font-size:10.5px;margin-top:7px;letter-spacing:.6px}
  .chartlegend b{color:#e8823c;font-weight:500}
  .chartlegend i{color:#9aa6b8;font-style:normal}

  /* 群友日记：左名单右时间线，点人不刷新 */
  .diarywrap{display:grid;grid-template-columns:240px 1fr;gap:18px;align-items:start}
  @media(max-width:720px){.diarywrap{grid-template-columns:1fr}}
  .diarylist{display:flex;flex-direction:column;gap:5px;max-height:420px;overflow:auto}
  .dperson{display:grid;grid-template-columns:1fr auto;gap:1px 9px;padding:9px 12px;cursor:pointer;position:relative;
    border:1px solid var(--line);background:rgba(17,24,35,.6);transition:.15s;
    clip-path:polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,10px 100%,0 calc(100% - 10px))}
  .dperson:hover{border-color:rgba(56,189,248,.45)}
  .dperson.on{border-color:var(--accent);background:rgba(56,189,248,.10)}
  /* 主人置顶：金边 + 星标，跟「记住的人」那边一个样式 */
  .dperson.pinned{border-color:rgba(251,191,36,.55);background:rgba(251,191,36,.07)}
  .dperson.pinned .nm{color:#fde68a}
  .dperson .pinmark{position:absolute;left:-1px;top:-1px;color:#fbbf24;font-size:9px;
    line-height:1;padding:2px 3px}
  .dperson .nm{font-size:13px;font-weight:700;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dperson .id{font-size:10px;color:var(--fg3);font-family:Consolas,monospace;grid-row:2}
  .dperson .ct{font-size:10px;color:var(--fg3);grid-row:1/3;align-self:center;white-space:nowrap}
  .diarydetail{border:1px solid var(--line);padding:0;background:rgba(13,18,25,.6);
    /* 高度封顶：日记会一直往下攒，不封的话整个面板会被这一块越拉越长。
       clip-path 会连滚动条一起裁掉，所以拆成两层：
       外层负责裁角，内层负责滚动。 */
    max-height:420px;display:flex;flex-direction:column;
    clip-path:polygon(0 0,calc(100% - 14px) 0,100% 14px,100% 100%,14px 100%,0 calc(100% - 14px))}
  .diarydetail .dscroll{padding:16px 20px;overflow-y:auto;overflow-x:hidden;min-height:180px}
  .diarydetail h3{font-size:16px;margin-bottom:2px}
  .diarydetail .qq{font-family:Consolas,monospace;font-size:11px;color:var(--fg3);margin-bottom:12px}
  .dtl{list-style:none;display:flex;flex-direction:column;gap:1px}
  .dtl li{display:grid;grid-template-columns:76px 1fr;gap:11px;padding:7px 0;border-bottom:1px dashed rgba(30,43,61,.7)}
  .dtl li:last-child{border-bottom:0}
  .dtl time{display:flex;flex-direction:column;font-family:Consolas,monospace;line-height:1.3}
  .dtl time b{font-size:12px;color:var(--accent);font-weight:600}
  .dtl time span{font-size:10px;color:var(--fg3)}
  .dtl p{font-size:13px;line-height:1.55;color:var(--fg2)}
  .hint{font-size:12px;color:var(--fg3);padding:8px 0}

  .starbox{display:flex;gap:22px;flex-wrap:wrap}
  .starcard{flex:1 1 340px;min-width:300px}
  #star{width:100%;height:300px;display:block}
  #people{width:100%;height:460px;display:block;touch-action:none;cursor:grab}
  /* 星系参数滑条 */
  .galsliders{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:10px;align-items:center}
  .galsliders label{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--fg3)}
  .galsliders label span{width:24px;flex:none}
  .galsliders input[type=range]{width:78px;height:3px;-webkit-appearance:none;appearance:none;
    background:var(--line2);outline:none;border-radius:2px}
  .galsliders input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;
    background:var(--accent);border-radius:50%;cursor:pointer;box-shadow:0 0 8px var(--glow)}
  .galsliders label em{font-style:normal;font-family:Consolas,monospace;color:var(--accent);width:34px;font-size:10.5px}
  .galauto{font-size:11px;padding:3px 10px;cursor:pointer;font-family:inherit;
    border:1px solid var(--line2);background:transparent;color:var(--fg3);
    clip-path:polygon(0 0,calc(100% - 7px) 0,100% 7px,100% 100%,7px 100%,0 calc(100% - 7px))}
  .galauto.on{border-color:rgba(56,189,248,.5);color:var(--accent);background:rgba(56,189,248,.1)}
  /* 选中后的详情条 */
  #galaxyDetail:empty{display:none}
  .gdet{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px;padding:9px 13px;
    border:1px solid var(--line);background:rgba(17,24,35,.72);
    clip-path:polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,10px 100%,0 calc(100% - 10px))}
  .gdet .gnm{font-size:14px;font-weight:700;color:var(--fg)}
  .gdet .gid{font-size:11px;color:var(--fg3);font-family:Consolas,monospace}
  .gdet .grel{font-size:11px;padding:1px 8px;border:1px solid;border-radius:2px}
  .gdet .ggrp{font-size:11px;color:var(--fg3)}
  .gdet .gnote{font-size:12px;color:var(--fg2);flex:1 1 100%;line-height:1.5}
  .starlabels{display:flex;flex-wrap:wrap;gap:7px 15px;margin-top:9px;font-size:11px;
    color:var(--fg2);letter-spacing:.5px}
  .starlabel{display:flex;align-items:center;gap:6px}
  .starlabel i{width:7px;height:7px;display:inline-block;box-shadow:0 0 8px currentColor}
  .starbar{margin-bottom:10px}
  .starbar .t{display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px}
  .starbar .t b{color:var(--fg);font-weight:600;letter-spacing:.5px}
  .starbar .t span{color:var(--fg3);font-variant-numeric:tabular-nums;
    font-family:ui-monospace,Consolas,monospace}
  .starbar .track{height:7px;background:#0d141d;border:1px solid var(--line);overflow:hidden}
  .starbar .fill{height:100%;transition:width .5s cubic-bezier(.4,0,.2,1)}
  .winhint{color:var(--fg3);font-size:11px;margin-top:12px;line-height:1.6;
    padding:8px 11px;border-left:2px solid var(--line2);background:rgba(56,189,248,.04)}
  .winhint[hidden]{display:none}
  .winrow{display:flex;gap:8px;flex-wrap:wrap}
  .winbtn{background:#111823;border:1px solid var(--line);color:var(--fg2);
    padding:7px 14px;font-size:11.5px;cursor:pointer;letter-spacing:.8px;
    transition:all .18s;font-family:inherit;text-transform:uppercase}
  .winbtn:hover{border-color:var(--line2);color:var(--fg);box-shadow:0 0 14px rgba(56,189,248,.15)}
  .winbtn.on{background:rgba(56,189,248,.13);border-color:var(--accent);color:var(--accent);
    box-shadow:0 0 16px rgba(56,189,248,.28),inset 0 0 16px rgba(56,189,248,.07)}

  .peoplelist{max-height:460px;overflow:auto}
  .plrow{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #16202e;
    transition:background .15s,box-shadow .15s;cursor:pointer}
  .plrow:hover{background:rgba(56,189,248,.05);box-shadow:inset 2px 0 0 var(--accent)}
  .plrow.on{background:rgba(56,189,248,.13);box-shadow:inset 2px 0 0 var(--accent)}
  .plrow.on .nm{color:var(--accent)}
  /* 置顶那位：金边 + 星标，第一眼就找得到 */
  .plrow.pinned{background:rgba(251,191,36,.06);box-shadow:inset 2px 0 0 #fbbf24}
  .plrow.pinned .nm{color:#fde68a;font-weight:700}
  .pinmark{color:#fbbf24;font-size:10px;flex:none;margin-left:-4px}
  .plrow:last-child{border-bottom:none}
  .plrow .dot{width:8px;height:8px;border-radius:50%;flex:none;box-shadow:0 0 9px currentColor}
  .plrow .nm{flex:1;font-size:13px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .plrow .rel{font-size:10px;padding:2px 8px;border:1px solid transparent;flex:none;letter-spacing:.8px}
  .rel.owner{background:rgba(251,191,36,.13);color:#fbbf24;border-color:rgba(251,191,36,.35)}
  .rel.admin{background:rgba(34,211,238,.12);color:#22d3ee;border-color:rgba(34,211,238,.3)}
  .rel.friend{background:rgba(74,222,128,.1);color:#4ade80;border-color:rgba(74,222,128,.25)}
  .rel.stranger{background:rgba(100,116,139,.12);color:#94a3b8;border-color:rgba(100,116,139,.25)}
  .plrow .bar2{width:54px;height:3px;background:#0d141d;overflow:hidden;flex:none;border:1px solid var(--line)}
  .plrow .bar2 i{display:block;height:100%;background:linear-gradient(90deg,#38bdf8,#f472b6)}
  .gtag{font-size:9.5px;padding:1px 6px;border:1px solid #24344a;color:var(--fg3);flex:none;letter-spacing:.5px}
  .empty{color:var(--fg3);font-size:12.5px;padding:20px 11px;text-align:center;letter-spacing:1px}

  /* 外部插件贡献的区块 */
  .extrow{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 10px}
  .exthint{color:var(--fg3);font-size:11px;margin-top:8px;font-family:ui-monospace,Consolas,monospace}
  .exthint code{color:var(--fg2)}
  .extlink{color:var(--accent);text-decoration:none}
  .extlink:hover{text-decoration:underline}
  /* 外部插件的在线调参 */
  .tunebox{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}
  .tunegrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
  .tfield label{display:block;font-size:10.5px;letter-spacing:1.6px;text-transform:uppercase;
    color:var(--fg3);margin-bottom:7px}
  .trow{display:flex;align-items:center;gap:11px}
  .trow b{color:var(--accent);font-size:14px;font-variant-numeric:tabular-nums;
    min-width:38px;text-align:right;text-shadow:0 0 14px var(--glow)}
  input[type=range]{flex:1;-webkit-appearance:none;appearance:none;height:4px;
    background:#0d141d;border:1px solid var(--line);outline:none;cursor:pointer}
  input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;
    background:var(--accent);box-shadow:0 0 12px var(--glow);cursor:pointer;border:1px solid #a5e4ff}
  .thint{color:var(--fg3);font-size:10.5px;margin-top:6px;line-height:1.5}
  .tuneapply{display:flex;align-items:center;gap:14px;margin-top:16px;padding-top:14px;
    border-top:1px solid var(--line);flex-wrap:wrap}
  .applybtn{background:rgba(56,189,248,.13);border:1px solid var(--accent);color:var(--accent);
    padding:7px 20px;font-size:11.5px;letter-spacing:1.6px;text-transform:uppercase;
    cursor:pointer;font-family:inherit;transition:all .18s;
    box-shadow:0 0 16px rgba(56,189,248,.22),inset 0 0 16px rgba(56,189,248,.06)}
  .applybtn:hover{background:rgba(56,189,248,.22);box-shadow:0 0 24px rgba(56,189,248,.35)}
  .applybtn:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
  .tmsg{font-size:12px;color:var(--ok)}
  .tmsg.err{color:var(--bad)}
  .tfile{font-size:10px;color:var(--fg3);margin-left:auto;font-family:ui-monospace,Consolas,monospace}
  table{width:100%;border-collapse:separate;border-spacing:0}
  th{text-align:left;padding:8px 12px;font-size:10px;letter-spacing:1.7px;color:var(--fg3);
    font-weight:600;text-transform:uppercase;border-bottom:1px solid var(--line2)}
  td{text-align:left;padding:10px 12px;border-bottom:1px solid #16202e;vertical-align:top;font-size:13px}
  tbody tr:hover{background:rgba(56,189,248,.05)}
  td.mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:var(--fg2)}
  .trunc{max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .extscroll{max-height:380px;overflow:auto}
  .tag{display:inline-block;padding:2px 9px;font-size:10.5px;letter-spacing:.5px;
    background:#141c27;color:var(--fg2);border:1px solid var(--line)}
  .tag.on{background:rgba(74,222,128,.1);color:var(--ok);border-color:rgba(74,222,128,.3)}
  .tag.off{background:rgba(248,113,113,.09);color:var(--bad);border-color:rgba(248,113,113,.25)}

  /* 最近消息里挂在消息下面的"想法 / 回的" */
  .thline,.reline{margin-top:5px;font-size:12px;line-height:1.55;display:flex;gap:6px;align-items:flex-start;
    white-space:normal;overflow:visible;text-overflow:clip}
  .thline{color:#a5b4c8;font-style:italic}
  .reline{color:#cfe3f5}
  .thtag,.retag{flex:none;font-size:9.5px;line-height:1.7;padding:0 5px;letter-spacing:.5px;
    font-style:normal;font-family:ui-monospace,Consolas,monospace;border:1px solid}
  .thtag{color:#7dd3fc;border-color:rgba(125,211,252,.35);background:rgba(56,189,248,.08)}
  .retag{color:#4ade80;border-color:rgba(74,222,128,.35);background:rgba(74,222,128,.08)}
  /* 有想法/回复的行不该被 .trunc 截断 */
  td.trunc > div{white-space:normal;max-width:420px}
  @media(max-width:640px){
    .wrap{padding:18px 14px 0}
    #chart{height:130px}
    #star{height:250px}
    #people{height:380px}
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">◎</div>
    <div>
      <h1>Mood Kit</h1>
      <div class="sub">情绪状态 · 人物关系 · 每 2 秒刷新</div>
    </div>
    <div class="live"><span class="dot on" id="liveDot"></span><span id="liveText">在线</span></div>
  </header>

  <!-- 改了源码但没重启 DSH 时的提示（服务端代码是一次性加载进内存的） -->
  <div class="stalebar" id="staleBar" hidden>
    <span class="staleicon">⚠</span>
    <span><b>代码已更新，但 DSH 还在跑旧的。</b>重启 DSH 才能生效。改动：</span>
    <code id="staleFiles"></code>
  </div>

  <div class="row" id="cards"></div>

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
        <div class="chartlegend"><i>实线</i> 极性　<b>虚线</b> 强度 0-10　·　<span style="color:#4a5568">越淡 = 越旧，7 天后自动清掉</span></div>
      </div>
    </div>
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
        <div class="winhint" id="starHint" hidden></div>
        <div class="k" style="margin:14px 0 8px">切换时间窗</div>
        <div class="winrow" id="starWindows">
          <button data-win="hour" class="winbtn">近 1 小时</button>
          <button data-win="day" class="winbtn on">近 24 小时</button>
          <button data-win="all" class="winbtn">全部</button>
        </div>
      </div>
    </div>
  </div>

  <h2>记忆星系</h2>
  <div class="panel">
    <div class="starbox">
      <div class="starcard">
        <canvas id="people"></canvas>
        <div class="starlabels" id="peopleLegend"></div>
        <div class="galsliders">
          <label><span>转速</span><input type="range" min="0" max="100" value="35" data-gal="speed"><em>0.35</em></label>
          <label><span>剔透</span><input type="range" min="20" max="100" value="62" data-gal="solid"><em>0.62</em></label>
          <label><span>大小</span><input type="range" min="60" max="180" value="100" data-gal="size"><em>1.00</em></label>
          <label><span>距离</span><input type="range" min="55" max="200" value="102" data-gal="dist"><em>1.02</em></label>
          <button type="button" class="galauto on" data-gal="auto">自动旋转</button>
        </div>
        <div id="galaxyDetail"></div>
        <div class="starlabels" style="opacity:.6">拖拽旋转 · 滚轮缩放 · 点一个人看详情</div>
      </div>
      <div class="starcard">
        <div class="k" style="margin-bottom:10px">记住的人</div>
        <div id="peopleList" class="peoplelist"></div>
      </div>
    </div>
  </div>

  <h2>群友日记</h2>
  <div class="panel">
    <div class="diarywrap">
      <div id="diaryList" class="diarylist"><p class="hint">还没有日记内容（聊天插件没接，或者还没到更新时间）。</p></div>
      <div id="diaryDetail" class="diarydetail"><div class="dscroll"><p class="hint">左边选一个人，看他身上发生过什么。</p></div></div>
    </div>
  </div>

  <div id="extras"></div>
</div>

<script>
// ── 透明模式判断 ──
// 嵌进 DSH 主界面时（iframe）背景应该透出宿主；单独打开 /mood-kit 时保留深色底。
// 判定：① 显式 ?transparent=1 / 0；② 被 iframe 嵌着（window.self !== window.top）。
(function () {
  const q = new URLSearchParams(location.search).get('transparent');
  const embedded = window.self !== window.top;
  const bare = q === '1' ? true : q === '0' ? false : embedded;
  if (bare) {
    document.documentElement.classList.add('bare');
    // 调试标记：F12 里看 <html> 有没有 data-mood-bare="1" 就知道判定生效没
    document.documentElement.dataset.moodBare = '1';
  }
})();

const fmtTime = (ms) => ms ? new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }) : '';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const STAR_COLORS = {
  开心: '#fbbf24', 好奇: '#60a5fa', 烦: '#f87171', 亲近: '#f472b6',
  疲惫: '#a78bfa', 得意: '#34d399', 尴尬: '#94a3b8', 平静: '#4b5563',
};
const REL_COLORS = { owner: '#fbbf24', admin: '#22d3ee', friend: '#4ade80', stranger: '#64748b' };
const REL_NAMES = { owner: '主人', admin: '管理', friend: '熟人', stranger: '陌生' };
const GROUP_COLORS = ['#38bdf8', '#a78bfa', '#fb923c', '#4ade80', '#f472b6'];

let starWindow = 'day';
let starData = null;

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
  document.getElementById('moodIntensity').textContent = String(intensity);
  const segs = document.getElementById('moodSegs');
  if (segs) {
    const tierOf = (n) => (n <= 2 ? 'on1' : n <= 4 ? 'on2' : n <= 6 ? 'on3' : n <= 8 ? 'on4' : 'on5');
    const tier = tierOf(intensity);
    let html = '';
    for (let i = 0; i < 10; i += 1) html += '<i class="' + (i < intensity ? tier : '') + '"></i>';
    segs.innerHTML = html;
  }
  const labels = ['没有情绪', '几乎不影响', '很淡', '轻', '轻', '明显', '明显', '重', '重', '上头', '上头'];
  const labelEl = document.getElementById('moodLabel');
  if (labelEl) labelEl.textContent = latest && latest.mood ? ('语气：' + (labels[intensity] || '—')) : '当前没有情绪';

  // meta 里带上"多久以前"，让"面板不动"看着像"它确实没情绪"而不是"系统卡了"。
  // 模型经常连着十几轮都返回"无"，这段时间历史里不会新增点，曲线和星图自然是不动的。
  const ago = (() => {
    if (!latest || !latest.at) return '';
    const mins = Math.round((Date.now() - latest.at) / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return mins + ' 分钟前';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + ' 小时前';
    return Math.round(hours / 24) + ' 天前';
  })();
  const meta = latest
    ? (fmtTime(latest.at) + (ago ? '（' + ago + '）' : '') + ' · ' + latest.sessionKey +
       ' · 极性 ' + (latest.polarity > 0 ? '+' : '') + Number(latest.polarity || 0).toFixed(2))
    : '还没有情绪记录';
  document.getElementById('moodMeta').textContent = meta;
  drawChart(mh.points || []);
}

function drawChart(points) {
  const cv = document.getElementById('chart');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 420;
  const h = 150;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pad = 6;
  const midY = h / 2;
  ctx.strokeStyle = '#1e2b3d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY); ctx.lineTo(w, midY);
  ctx.moveTo(0, pad); ctx.lineTo(w, pad);
  ctx.moveTo(0, h - pad); ctx.lineTo(w, h - pad);
  ctx.stroke();
  if (!points.length) {
    ctx.fillStyle = '#5a6b82';
    ctx.font = '12px sans-serif';
    ctx.fillText('还没有数据', pad + 4, midY - 8);
    return;
  }
  const toX = (i) => points.length === 1 ? w / 2 : pad + (w - pad * 2) * (i / (points.length - 1));
  const toY = (p) => midY - Math.max(-1, Math.min(1, p)) * (midY - pad);

  // 每个点按"年龄"分段淡出：越旧越淡，老到一定程度只剩一丝轮廓。
  // 权重由后端算好放在 p.weight（见 src/fade.js），前端只负责用。
  const wt = (p) => (typeof p.weight === 'number' ? p.weight : 1);

  // 极性实线：逐段画，每段透明度取两端平均值，这样曲线本身就有明暗过渡
  ctx.lineWidth = 1.5;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const alpha = (wt(a) + wt(b)) / 2;
    ctx.beginPath();
    ctx.moveTo(toX(i - 1), toY(a.polarity));
    ctx.lineTo(toX(i), toY(b.polarity));
    ctx.strokeStyle = 'rgba(154,166,184,' + (0.12 + alpha * 0.88).toFixed(3) + ')';
    ctx.stroke();
  }

  // 强度虚线：同样分段
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1.2;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const alpha = (wt(a) + wt(b)) / 2;
    const ya = h - pad - (Math.max(0, Math.min(10, Number(a.intensity) || 0)) / 10) * (h - pad * 2);
    const yb = h - pad - (Math.max(0, Math.min(10, Number(b.intensity) || 0)) / 10) * (h - pad * 2);
    ctx.beginPath();
    ctx.moveTo(toX(i - 1), ya);
    ctx.lineTo(toX(i), yb);
    ctx.strokeStyle = 'rgba(232,130,60,' + (0.1 + alpha * 0.8).toFixed(3) + ')';
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // 最近几个点额外画个亮点，一眼能看出"最新在哪"
  const tail = Math.min(6, points.length);
  for (let i = points.length - tail; i < points.length; i += 1) {
    const p = points[i];
    const alpha = wt(p);
    ctx.beginPath();
    ctx.arc(toX(i), toY(p.polarity), 1.6 + alpha * 1.4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(154,166,184,' + (0.15 + alpha * 0.85).toFixed(3) + ')';
    ctx.fill();
  }
}

function renderStars(s) {
  const stats = s.moodStats;
  if (!stats) return;
  starData = stats[starWindow] || stats.day;
  if (!starData) return;

  // 窗口内几乎没有样本时，条形图旁边写一句说明 ——
  // 否则"近1小时 100% 平静"看着像 bug，其实是这段时间模型一直在说"无"。
  const winLabel = { hour: '近 1 小时', day: '近 24 小时', all: '全部' }[starWindow] || '';
  const hint = document.getElementById('starHint');
  if (hint) {
    const total = Number(starData.total) || 0;
    if (total < 2) {
      hint.hidden = false;
      hint.textContent = winLabel + '只有 ' + (total > 0 ? '一点点' : '没有') + '情绪记录 —— 这段时间她一直没被打动，不是面板卡了。';
    } else {
      hint.hidden = true;
    }
  }

  const classes = Object.keys(starData.ratio || {});
  const maxR = Math.max(...classes.map((c) => starData.ratio[c] || 0), 0.0001);

  const cv = document.getElementById('star');
  if (cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 340;
    const h = 300;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) / 2 - 42;
    const n = classes.length;
    g.strokeStyle = '#1e2b3d';
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
    g.beginPath();
    for (let i = 0; i < n; i += 1) {
      const a = (Math.PI * 2 * i) / n - Math.PI / 2;
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    }
    g.stroke();
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
    g.fillStyle = 'rgba(56,189,248,0.2)';
    g.fill();
    g.strokeStyle = 'rgba(56,189,248,0.9)';
    g.lineWidth = 2;
    g.stroke();
    for (let i = 0; i < n; i += 1) {
      const cls = classes[i];
      const val = (starData.ratio[cls] || 0) / maxR;
      const a = (Math.PI * 2 * i) / n - Math.PI / 2;
      g.beginPath();
      g.arc(cx + Math.cos(a) * R * val, cy + Math.sin(a) * R * val, 3.2, 0, Math.PI * 2);
      g.fillStyle = STAR_COLORS[cls] || '#9aa6b8';
      g.fill();
    }
    g.font = '12px ui-sans-serif,system-ui,sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < n; i += 1) {
      const cls = classes[i];
      const a = (Math.PI * 2 * i) / n - Math.PI / 2;
      g.fillStyle = STAR_COLORS[cls] || '#9aa6b8';
      g.fillText(cls, cx + Math.cos(a) * (R + 24), cy + Math.sin(a) * (R + 24));
    }
  }

  const legend = document.getElementById('starLegend');
  if (legend) {
    legend.innerHTML = classes
      .map((c) => '<span class="starlabel"><i style="background:' + (STAR_COLORS[c] || '#9aa6b8') + '"></i>' + c + '</span>')
      .join('');
  }

  const bars = document.getElementById('starBars');
  if (bars) {
    // 数据没变就不重写 —— 每 2 秒重写一次 innerHTML 会让进度条的 transition
    // 一直从头播，看起来像在抽动。
    const sig = classes.map((c) => c + ':' + ((starData.ratio[c] || 0) * 100).toFixed(1)).join(',');
    if (bars.dataset.sig !== sig) {
      bars.dataset.sig = sig;
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
}

let gal = null;

// ── 3D 星系 ─────────────────────────────────────────────
//
// 为什么手写投影而不是上 Three.js：
//   才几十个点，Three.js 那 600KB 换来的是材质和光照，这里用不上；
//   而且面板整个是模板字符串，塞一坨库进去维护起来是灾难。
//   自己算一个透视投影 + 深度排序，够用、可控、不引依赖。
//
// 交互：拖拽旋转 / 滚轮缩放 / 悬停高亮 / 点击选中。
// 视角状态。带几个可调参数（面板上有滑条）：
//   speed  自动旋转速度
//   solid  节点实心度 —— 越小越剔透
//   size   节点大小
//   dist   镜头远近
let galView = {
  rotY: 0.45, rotX: -0.42, dist: 1.02,
  auto: true, dragging: false, lx: 0, ly: 0,
  speed: 0.35,   // 0 ~ 1，映射到每帧转角
  solid: 0.62,   // 0.2 ~ 1，玻璃球的实心程度
  size: 1,       // 0.6 ~ 1.8
};
let galSel = null;      // 选中的节点 id
let galHover = null;    // 悬停的节点 id
let galRaf = null;      // 动画帧句柄
let galNodes = [];      // 当前节点（给交互用）

/**
 * 把节点铺到球壳上。
 *
 * 用 Fibonacci 球是刻意选的：均匀、没有极点堆积，看起来才像星云而不是"一圈一圈"。
 * 半径按亲近度定 —— 主人最近，不熟的在外环，正好对应"离我多远"。
 */
function galaxyLayout3d(nodes) {
  const n = Math.max(1, nodes.length);
  const golden = Math.PI * (3 - Math.sqrt(5));
  return nodes.map((node, i) => {
    // Fibonacci 球面
    const y = 1 - (i / Math.max(1, n - 1)) * 2;      // 1 → -1
    const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    // 距离：亲近度越高越靠近中心
    const shell = 0.42 + (1 - (Number(node.warmth) || 0.5)) * 0.62;
    return {
      ...node,
      // 单位球上的位置 × 壳层半径
      ux: Math.cos(theta) * radiusAtY,
      uy: y,
      uz: Math.sin(theta) * radiusAtY,
      shell,
    };
  });
}

/**
 * 投影：绕 X/Y 旋转，然后透视除法。
 * @param {{ux:number,uy:number,uz:number,shell:number}} p
 */
function project3d(p, view, cx, cy, R) {
  const cosY = Math.cos(view.rotY), sinY = Math.sin(view.rotY);
  const cosX = Math.cos(view.rotX), sinX = Math.sin(view.rotX);
  const sx = p.ux * p.shell, sy = p.uy * p.shell, sz = p.uz * p.shell;
  // 绕 Y 轴
  const x1 = sx * cosY - sz * sinY;
  const z1 = sx * sinY + sz * cosY;
  // 绕 X 轴
  const y1 = sy * cosX - z1 * sinX;
  const z2 = sy * sinX + z1 * cosX;
  // 透视：z 越大（离观察者越近）越放大
  const persp = 1.9 / (1.9 + z2 * 1.15);
  const scale = R * view.dist * persp;
  return {
    x: cx + x1 * scale,
    y: cy + y1 * scale,
    z: z2,                     // 深度，用来排序和调透明度
    r: persp,                  // 相对大小
  };
}

function drawGalaxy(nodes, w, h) {
  const cv = document.getElementById('people');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) * 0.44;

  const groupIdx = {};
  let gi = 0;
  for (const p of nodes) if (!(p.group in groupIdx)) groupIdx[p.group] = gi++;

  // 背景：网格 + 几个同心圈（当作"轨道的投影"）
  g.strokeStyle = 'rgba(56,189,248,0.05)';
  g.lineWidth = 1;
  for (let x = 0; x < w; x += 34) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = 0; y < h; y += 34) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }

  if (!nodes.length) {
    g.fillStyle = 'rgba(148,163,184,.55)';
    g.font = '12px ui-sans-serif,system-ui,sans-serif';
    g.textAlign = 'center';
    g.fillText('还没记住任何人', cx, cy);
    drawCore(g, cx, cy);
    return;
  }

  if (!gal || gal.key !== nodes.length) {
    gal = { key: nodes.length, pts: galaxyLayout3d(nodes) };
  }
  galNodes = gal.pts;

  // 投影 + 按深度排序（远的先画）
  const proj = gal.pts.map((p) => ({ p, q: project3d(p, galView, cx, cy, R) }));
  proj.sort((a, b) => b.q.z - a.q.z);

  // 挑出最靠前的十几个给它们画名字（+ 主人永远标）。
  // 全标会糊成一团，全不标又不知道谁是谁，取个中间。
  const labelIds = new Set();
  const byDepth = [...proj].sort((a, b) => a.q.z - b.q.z); // z 越小越靠前
  for (const { p } of byDepth.slice(0, 14)) labelIds.add(p.id);
  for (const { p } of proj) if (p.relation === 'owner') labelIds.add(p.id);

  const hot = (p) => p.id === galSel || p.id === galHover;

  // 连线：从核心到每个节点
  for (const { p, q } of proj) {
    const isHot = hot(p);
    const col = p.relation === 'owner'
      ? REL_COLORS.owner
      : (GROUP_COLORS[groupIdx[p.group] ?? 0] || REL_COLORS[p.relation] || '#64748b');
    // 淡出远处的线，制造景深
    const depth = (q.z + 1.2) / 2.4;             // 0(远) ~ 1(近)
    const alpha = (0.06 + depth * 0.34) * (isHot ? 2.6 : 1);
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(q.x, q.y);
    g.strokeStyle = col;
    g.globalAlpha = Math.min(0.85, alpha * (0.4 + p.warmth * 0.6));
    g.lineWidth = isHot ? 2.4 : 0.6 + depth * 1.3;
    g.stroke();
    g.globalAlpha = 1;
  }

  // 节点
  for (const { p, q } of proj) {
    const col = p.relation === 'owner'
      ? REL_COLORS.owner
      : (GROUP_COLORS[groupIdx[p.group] ?? 0] || REL_COLORS[p.relation] || '#64748b');
    const depth = (q.z + 1.2) / 2.4;             // 0 ~ 1
    const isHot = hot(p);
    // 节点要够大才看得出多面体：原来直径 7~14，棱角全糊成圆点。
    const r = (5.5 + p.warmth * 5.5) * q.r * (galView.size ?? 1);
    // 远的更暗
    const dim = 0.30 + depth * 0.55;
    // 剔透度：越靠前越"实"，远的更透明 —— 像玻璃球一样看得出层叠
    const solid = (galView.solid ?? 0.55) * (0.55 + depth * 0.45);

    // 光晕（外面那圈雾）
    const halo = g.createRadialGradient(q.x, q.y, r * 0.5, q.x, q.y, r * 3.4);
    halo.addColorStop(0, col + (isHot ? '66' : '33'));
    halo.addColorStop(0.55, col + '14');
    halo.addColorStop(1, col + '00');
    g.beginPath();
    g.arc(q.x, q.y, r * 3.4, 0, Math.PI * 2);
    g.fillStyle = halo;
    g.globalAlpha = dim * 0.9;
    g.fill();
    g.globalAlpha = 1;

    // 本体：球体。
    //
    // 试过低多边形那一版，问题是面太少、每个面颜色跳变太大，
    // 一堆紫块看着像低像素图标，反而脏。球体虽然"平"，但干净。
    //
    // 立体感靠三层叠出来，不是靠贴一个白点：
    //   ① 主体：光从左上来的径向渐变（亮→本色→暗）
    //   ② 内缘光：右上角一圈反光，模拟球面掠射
    //   ③ 外缘暗边：底部压暗一点，球才"圆"得出来
    drawSphere(g, q.x, q.y, r, col, solid, isHot);

    // 边缘细描：内侧一点亮边（大气层的感觉）
    g.beginPath();
    g.arc(q.x, q.y, r, 0, Math.PI * 2);
    g.strokeStyle = isHot ? 'rgba(255,255,255,.85)' : lighten(col, 0.4) + '77';
    g.lineWidth = isHot ? 1.4 : 0.7;
    g.globalAlpha = Math.min(1, solid + 0.15);
    g.stroke();
    g.globalAlpha = 1;

    // 名字：只给最靠前的十几个 + 选中的画。
    // 八十个名字全画出来就是一团糊 —— 只有正面朝观察者的那些值得标，
    // 远处的能不能看清无所谓，转一转就转过来了。
    if (isHot || labelIds.has(p.id)) {
      const label = p.name.length > 9 ? p.name.slice(0, 9) + '…' : p.name;
      g.font = '600 ' + (isHot ? 12 : 10.5) + 'px ui-sans-serif,system-ui,sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'top';
      g.globalAlpha = isHot ? 1 : 0.55 + depth * 0.45;
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(10,14,20,.92)';
      g.strokeText(label, q.x, q.y + r + 4);
      g.fillStyle = isHot ? '#fff' : '#cfe3f5';
      g.fillText(label, q.x, q.y + r + 4);
      g.globalAlpha = 1;
    }
  }

  // 星环：套在核心外面的一圈椭圆，跟着视角一起转。
  //
  // 用椭圆而不是正圆，是为了让它"躺"在一个倾斜的轨道面上 ——
  // 正圆看着像画了个靶子，椭圆才有行星环的意思。
  drawRing(g, cx, cy, R, galView);

  drawCore(g, cx, cy);
}

/** 颜色工具：把 #rrggbb 变亮一些（t: 0~1） */
function lighten(hex, t) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  const mix = (v) => Math.round(v + (255 - v) * t);
  return '#' + [mix(r), mix(gg), mix(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** 颜色工具：把 #rrggbb 变暗一些（t: 0~1） */
function darken(hex, t) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  const mix = (v) => Math.round(v * (1 - t));
  return '#' + [mix(r), mix(gg), mix(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/**
 * 星环：核心外面两圈倾斜的椭圆环。
 *
 * 环会跟着 rotY 转、跟着 rotX 压扁 —— 转视角的时候看得出来它是"围着核心转的"，
 * 不是画上去的。两条环半径不同、亮度不同，叠起来有点层次。
 *
 * @param {CanvasRenderingContext2D} g
 * @param {number} cx
 * @param {number} cy
 * @param {number} R 星系半径
 * @param {{rotY:number, rotX:number, dist:number}} view
 */
function drawRing(g, cx, cy, R, view) {
  const rings = [
    { radius: 0.26, tilt: 0.30, alpha: 0.55, width: 2.4 },
    { radius: 0.36, tilt: 0.38, alpha: 0.32, width: 1.5 },
    { radius: 0.47, tilt: 0.45, alpha: 0.14, width: 1.0 },
  ];
  for (const ring of rings) {
    const rr = R * ring.radius * (view.dist ?? 1);
    // 椭圆短轴随 rotX 变化：转得越"侧"越扁
    const squash = Math.abs(Math.cos(view.rotX)) * (1 - ring.tilt) + 0.08;
    // 环在屏幕上的旋转角由 rotY 决定（视觉上像在绕核心转）
    const spin = view.rotY * 0.55;

    g.save();
    g.translate(cx, cy);
    g.rotate(spin);
    g.scale(1, Math.max(0.05, squash));

    // 主体
    g.beginPath();
    g.arc(0, 0, rr, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(56,189,248,' + ring.alpha + ')';
    g.lineWidth = ring.width;
    g.stroke();

    // 一点高光：环的左侧更亮，像被光照到
    const glow = g.createLinearGradient(-rr, 0, rr, 0);
    glow.addColorStop(0, 'rgba(147,197,253,0)');
    glow.addColorStop(0.25, 'rgba(147,197,253,' + ring.alpha * 1.6 + ')');
    glow.addColorStop(0.5, 'rgba(56,189,248,0)');
    g.beginPath();
    g.arc(0, 0, rr, 0, Math.PI * 2);
    g.strokeStyle = glow;
    g.lineWidth = ring.width + 0.8;
    g.stroke();

    g.restore();
  }
}

/**
 * 画一个球。
 *
 * 之前试过低多边形，面太少、每个面颜色跳变太大，一堆紫块看着像低像素图标。
 * 球体虽然"平"，但干净 —— 立体感靠下面三层叠，不是靠贴一个白点：
 *
 *   ① 主体：光从左上来，亮 → 本色 → 暗的径向渐变
 *   ② 内缘反光：右上角一圈很淡的环光，模拟球面的掠射
 *   ③ 底部压暗：外缘一圈暗，球才鼓得出来
 *
 * @param {CanvasRenderingContext2D} g
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 * @param {string} col 基色 #rrggbb
 * @param {number} alpha 整体透明度
 * @param {boolean} hot 是不是选中/悬停
 */
function drawSphere(g, cx, cy, r, col, alpha, hot) {
  g.globalAlpha = alpha;

  // ① 主体渐变：光源在左上 45°
  const lx = cx - r * 0.42;
  const ly = cy - r * 0.48;
  const body = g.createRadialGradient(lx, ly, r * 0.05, cx, cy, r * 1.28);
  body.addColorStop(0, lighten(col, 0.42));
  body.addColorStop(0.30, lighten(col, 0.12));
  body.addColorStop(0.62, col);
  body.addColorStop(0.88, darken(col, 0.34));
  body.addColorStop(1, darken(col, 0.62));
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fillStyle = body;
  g.fill();

  // ② 内缘反光：右上角一小片，越靠边越亮
  if (r > 2.5) {
    const shine = g.createRadialGradient(
      cx + r * 0.42, cy + r * 0.40, r * 0.15,
      cx + r * 0.42, cy + r * 0.40, r * 0.95,
    );
    shine.addColorStop(0, 'rgba(255,255,255,.22)');
    shine.addColorStop(1, 'rgba(255,255,255,0)');
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.save();
    g.clip();
    g.fillStyle = shine;
    g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.restore();
  }

  // ③ 底部压暗 —— 让球"落"下去一点，显得是立体的球不是圆片
  if (r > 2.5) {
    const shade = g.createLinearGradient(0, cy, 0, cy + r);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,.28)');
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.save();
    g.clip();
    g.fillStyle = shade;
    g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.restore();
  }

  // 选中时加一点内部泛光
  if (hot) {
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    glow.addColorStop(0, 'rgba(255,255,255,.35)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = glow;
    g.fill();
  }

  g.globalAlpha = 1;
}

/** 星系请求动画帧（自动旋转 / 拖拽惯性时用） */
function galaxyTick() {
  const cv = document.getElementById('people');
  if (!cv) { galRaf = null; return; }
  if (galView.auto && !galView.dragging) galView.rotY += 0.0035 * (galView.speed ?? 0.35) * 2.8;
  const w = cv.clientWidth || 520;
  drawGalaxy(galNodes, w, cv.clientHeight || 460);
  if (galView.auto || galView.dragging) galRaf = requestAnimationFrame(galaxyTick);
  else galRaf = null;
}

/** 把交互绑到 canvas 上（只绑一次） */
function bindGalaxyInteraction() {
  const cv = document.getElementById('people');
  if (!cv || cv.dataset.bound === '1') return;
  cv.dataset.bound = '1';
  cv.style.cursor = 'grab';

  const hit = (ev) => {
    const rect = cv.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const w = cv.clientWidth, h = cv.clientHeight;
    // 找最近的、在半径内的节点
    let best = null, bestD = 18;
    for (const p of galNodes) {
      const q = project3d(p, galView, w / 2, h / 2, Math.min(w, h) * 0.40);
      const d = Math.hypot(q.x - mx, q.y - my);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  };

  cv.addEventListener('pointerdown', (ev) => {
    galView.dragging = true;
    galView.lx = ev.clientX; galView.ly = ev.clientY;
    cv.style.cursor = 'grabbing';
    cv.setPointerCapture?.(ev.pointerId);
    if (!galRaf) galaxyTick();
  });

  cv.addEventListener('pointermove', (ev) => {
    if (galView.dragging) {
      const dx = ev.clientX - galView.lx;
      const dy = ev.clientY - galView.ly;
      galView.lx = ev.clientX; galView.ly = ev.clientY;
      galView.rotY += dx * 0.008;
      galView.rotX = Math.max(-1.35, Math.min(1.35, galView.rotX + dy * 0.006));
      return;
    }
    // 悬停高亮
    const p = hit(ev);
    const id = p ? p.id : null;
    if (id !== galHover) {
      galHover = id;
      cv.style.cursor = id ? 'pointer' : 'grab';
      const w = cv.clientWidth || 520;
      drawGalaxy(galNodes, w, cv.clientHeight || 460);
    }
  });

  const endDrag = () => {
    galView.dragging = false;
    cv.style.cursor = 'grab';
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('pointerleave', () => { galHover = null; endDrag(); });

  cv.addEventListener('click', (ev) => {
    const p = hit(ev);
    galSel = p ? p.id : null;
    renderGalaxyDetail(p || null);
    // 右侧列表跟着高亮（跟列表点回星图是同一个状态）
    const list = document.getElementById('peopleList');
    if (list) {
      for (const row of list.querySelectorAll('.plrow')) {
        row.classList.toggle('on', row.dataset.pid === galSel);
      }
      const on = list.querySelector('.plrow.on');
      on?.scrollIntoView({ block: 'nearest' });
    }
    const w = cv.clientWidth || 520;
    drawGalaxy(galNodes, w, cv.clientHeight || 460);
  });

  cv.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const next = galView.dist * (ev.deltaY > 0 ? 0.92 : 1.08);
    galView.dist = Math.max(0.55, Math.min(2.2, next));
    syncGalSliders();
    const w = cv.clientWidth || 520;
    drawGalaxy(galNodes, w, cv.clientHeight || 460);
  }, { passive: false });
}

/** 把 galView 的当前值写回滑条（滚轮改了距离时也要跟着动） */
function syncGalSliders() {
  const wrap = document.querySelector('.galsliders');
  if (!wrap) return;
  const fmt = (v) => (Math.round(v * 100) / 100).toFixed(2);
  for (const el of wrap.querySelectorAll('input[data-gal]')) {
    const key = el.dataset.gal;
    const v = galView[key];
    if (typeof v !== 'number') continue;
    el.value = String(Math.round(v * 100));
    const em = el.parentElement?.querySelector('em');
    if (em) em.textContent = fmt(v);
  }
}

/** 绑滑条（只绑一次） */
function bindGalSliders() {
  const wrap = document.querySelector('.galsliders');
  if (!wrap || wrap.dataset.bound === '1') return;
  wrap.dataset.bound = '1';

  const redraw = () => {
    const cv = document.getElementById('people');
    if (!cv) return;
    drawGalaxy(galNodes, cv.clientWidth || 520, cv.clientHeight || 460);
  };

  for (const el of wrap.querySelectorAll('input[data-gal]')) {
    el.addEventListener('input', () => {
      const key = el.dataset.gal;
      galView[key] = Number(el.value) / 100;
      const em = el.parentElement?.querySelector('em');
      if (em) em.textContent = (Number(el.value) / 100).toFixed(2);
      redraw();
      // 调转速的时候保证动画在跑
      if (key === 'speed' && galView.auto && !galRaf) galaxyTick();
    });
  }

  const autoBtn = wrap.querySelector('.galauto');
  if (autoBtn) {
    autoBtn.addEventListener('click', () => {
      galView.auto = !galView.auto;
      autoBtn.classList.toggle('on', galView.auto);
      if (galView.auto && !galRaf) galaxyTick();
    });
  }
}

/** 选中一个人后，在星系下方显示详情 */
function renderGalaxyDetail(p) {
  const box = document.getElementById('galaxyDetail');
  if (!box) return;
  if (!p) { box.innerHTML = ''; return; }
  const rel = REL_NAMES[p.relation] || p.relation;
  const relCol = REL_COLORS[p.relation] || '#64748b';
  const gs = p.groups || (p.group ? [p.group] : []);
  box.innerHTML =
    '<div class="gdet">' +
      '<span class="gnm">' + esc(p.name) + '</span>' +
      '<span class="gid">QQ ' + esc(p.id) + '</span>' +
      '<span class="grel" style="color:' + relCol + ';border-color:' + relCol + '55">' + esc(rel) + '</span>' +
      (gs.length ? '<span class="ggrp">' + gs.map((x) => '群 ' + esc(x)).join(' · ') + '</span>' : '') +
      '<span class="gnote">' + esc(p.note || '（还没有印象）') + '</span>' +
    '</div>';
}

function drawCore(g, cx, cy) {
  const hal = g.createRadialGradient(cx, cy, 0, cx, cy, 54);
  hal.addColorStop(0, 'rgba(56,189,248,.45)');
  hal.addColorStop(1, 'rgba(56,189,248,0)');
  g.beginPath();
  g.arc(cx, cy, 54, 0, Math.PI * 2);
  g.fillStyle = hal;
  g.fill();
  const core = g.createRadialGradient(cx - 5, cy - 6, 2, cx, cy, 19);
  core.addColorStop(0, '#dbeafe');
  core.addColorStop(0.5, '#60a5fa');
  core.addColorStop(1, '#1d4ed8');
  g.beginPath();
  g.arc(cx, cy, 17, 0, Math.PI * 2);
  g.fillStyle = core;
  g.fill();
  g.strokeStyle = 'rgba(191,219,254,.6)';
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = '#fff';
  g.font = '600 12px ui-sans-serif,system-ui,sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('我', cx, cy);
}

function renderPeople(s) {
  const people = s.people;
  if (!people) return;
  const nodes = people.nodes || [];
  const cv = document.getElementById('people');
  if (cv) {
    const w = cv.clientWidth || 520;
    const h = 460;
    // 节点集合变了才重新布点；否则保留当前视角，免得每 2 秒重置到初始角度
    if (!gal || gal.key !== nodes.length) {
      gal = { key: nodes.length, pts: galaxyLayout3d(nodes) };
    }
    galNodes = gal.pts;
    bindGalaxyInteraction();
    bindGalSliders();
    drawGalaxy(nodes, w, h);
    // 启动自动旋转（只启一次）
    if (!galRaf && galView.auto) galaxyTick();
  }
  const legend = document.getElementById('peopleLegend');
  if (legend) {
    const sm = people.summary || {};
    const relPart = Object.keys(REL_NAMES)
      .filter((k) => (sm[k] || 0) > 0)
      .map((k) => '<span class="starlabel"><i style="background:' + REL_COLORS[k] + '"></i>' + REL_NAMES[k] + ' ' + sm[k] + '</span>')
      .join('');
    const gIdx = {};
    let gi = 0;
    for (const p of nodes) if (!(p.group in gIdx)) gIdx[p.group] = gi++;
    const groupPart = Object.keys(gIdx)
      .map((g) => '<span class="starlabel"><i style="background:' + GROUP_COLORS[gIdx[g] % GROUP_COLORS.length] + '"></i>群 ' + g + '</span>')
      .join('');
    legend.innerHTML = relPart + (groupPart ? '<span style="width:1px;height:12px;background:#24344a;display:inline-block;margin:0 4px"></span>' + groupPart : '');
  }
  const list = document.getElementById('peopleList');
  if (list) {
    // 主人永远置顶：管他 warmth 算出来多少，主人就该在第一行。
    // 其余按亲近度排（后端已经排过了，这里只把 owner 提上来）。
    const ordered = nodes;
    // 只在名单变化时重建：这行每 2 秒刷一次，无条件重写会把悬停/滚动状态冲掉
    const sig = ordered.map((p) => p.id).join(',');
    if (list.dataset.sig !== sig) {
      list.dataset.sig = sig;
      list.innerHTML = ordered.length
        ? ordered.map((p) => {
            const gs = p.groups || (p.group ? [p.group] : []);
            const gTag = gs.length > 1 ? '<span class="gtag" title="' + esc(gs.join('、')) + '">' + gs.length + ' 群</span>' : '';
            const on = p.id === galSel ? ' on' : '';
            const pin = false; // 发布版没有置顶
            const pinMark = pin ? '<span class="pinmark" title="置顶">★</span>' : '';
            return '<div class="plrow' + on + (pin ? ' pinned' : '') + '" data-pid="' + esc(p.id) + '">' +
              '<span class="dot" style="background:' + (REL_COLORS[p.relation] || '#64748b') + '"></span>' +
              pinMark +
              '<span class="nm" title="' + esc(p.note) + '">' + esc(p.name) + '</span>' + gTag +
              '<span class="bar2"><i style="width:' + Math.round(p.warmth * 100) + '%"></i></span>' +
              '<span class="rel ' + p.relation + '">' + (REL_NAMES[p.relation] || p.relation) + '</span>' +
              '</div>';
          }).join('')
        : '<div class="empty">还没有人名记忆</div>';
      bindPeopleList();
    }
    // 高亮跟随星图选择
    for (const row of list.querySelectorAll('.plrow')) {
      row.classList.toggle('on', row.dataset.pid === galSel);
    }
  }
}

/**
 * 右侧「记住的人」列表的交互。
 *
 * 跟星图双向联动：
 *   点一行 → 星图选中这个节点 + 下方显示详情
 *   悬停一行 → 星图上对应节点高亮
 *
 * 只绑一次；列表重建后由调用方重新 bind。
 */
function bindPeopleList() {
  const list = document.getElementById('peopleList');
  if (!list) return;

  const findNode = (id) => galNodes.find((n) => String(n.id) === String(id)) || null;

  const redraw = () => {
    const cv = document.getElementById('people');
    if (!cv) return;
    drawGalaxy(galNodes, cv.clientWidth || 520, cv.clientHeight || 460);
  };

  list.onclick = (ev) => {
    const row = ev.target.closest('.plrow');
    if (!row) return;
    const p = findNode(row.dataset.pid);
    // 点同一个再点一次 = 取消选中
    galSel = galSel === row.dataset.pid ? null : row.dataset.pid;
    for (const r of list.querySelectorAll('.plrow')) {
      r.classList.toggle('on', r.dataset.pid === galSel);
    }
    renderGalaxyDetail(galSel ? p : null);
    redraw();
  };

  list.onmouseover = (ev) => {
    const row = ev.target.closest('.plrow');
    if (!row) return;
    if (galHover !== row.dataset.pid) {
      galHover = row.dataset.pid;
      redraw();
    }
  };

  list.onmouseleave = () => {
    if (galHover) { galHover = null; redraw(); }
  };
}

// ── 外部贡献区块（qq-kit 等插件提供）────────────────────
// 面板自己不知道有哪些聊天插件在跑，全靠它们注册的供给函数。
//
// ⚠️ 这块里有用户正在操作的控件（滑块、"真发/只观察"按钮）。
// 如果每 2 秒无条件重写 innerHTML，用户刚拖滑块就被打回原位、"应用"点了像没反应。
// 所以：区块结构只在"首次渲染"或"贡献方集合变了"时重建；
// 之后只更新纯展示的文字（连接状态、会话数之类）。
let extrasSig = '';
let extrasBuilt = false;

/** 判断这次要不要重建结构（只看会改变布局的部分） */
function extrasSignature(contrib) {
  const ids = Object.keys(contrib || {});
  const canApply = ids.map((id) => (contrib[id] && contrib[id]._canApply ? '1' : '0')).join('');
  const hasCfg = ids.map((id) => (contrib[id] && contrib[id].config ? JSON.stringify(contrib[id].config.adapter ?? '') : '')).join('|');
  return ids.join(',') + '#' + canApply + '#' + hasCfg;
}

/**
 * 代码过期提示：磁盘上的文件比进程里加载的新，说明改了没重启。
 *
 * 服务端代码（分类器、状态机、连这个面板的 HTML）都是 apply 时一次性读进内存的，
 * 改了不重启跑的还是旧的 —— 但界面看起来完全正常，很容易误判成"改的没生效"。
 */
function renderStale(s) {
  const bar = document.getElementById('staleBar');
  const files = document.getElementById('staleFiles');
  if (!bar || !files) return;
  const list = Array.isArray(s.stale) ? s.stale : [];
  if (!list.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  files.textContent = list.map((x) => x.file).join(' · ');
}

/**
 * 群友日记。
 *
 * 数据来自 qq-kit 的贡献（contributions["qq-kit"].diary）——
 * 日记归聊天插件管，这层只负责显示。没有贡献时给个提示，不装作有数据。
 */
let diarySelected = null;


function renderDiary(s) {
  const list = document.getElementById('diaryList');
  const detail = document.getElementById('diaryDetail');
  if (!list || !detail) return;

  const d = s?.contributions?.['qq-kit']?.diary;
  const groups = (d && d.groups) || [];
  // 取第一个有内容的群
  const group = groups.find((g) => (g.people || []).length > 0);
  if (!group) {
    list.innerHTML = '<p class="hint">还没有日记内容（还没到更新时间，或者聊天插件没接）。</p>';
    detail.innerHTML = '<div class="dscroll"><p class="hint">左边选一个人，看他身上发生过什么。</p></div>';
    return;
  }

  // 保持已选的人；没有就选第一个
  const people = group.people;
  if (!diarySelected || !people.some((p) => p.userId === diarySelected)) {
    diarySelected = people[0].userId;
  }

  // 左边名单（只在结构变了才重建，避免每 2 秒冲掉鼠标状态）
  const sig = group.id + ':' + people.map((p) => p.userId).join(',');
  if (list.dataset.sig !== sig) {
    list.dataset.sig = sig;
    list.innerHTML = people
      .map((p) => {
        const pin = false; // 发布版日记列表不置顶
        return (
          '<div class="dperson' + (pin ? ' pinned' : '') + '" data-uid="' + esc(p.userId) + '" data-gid="' + esc(group.id) + '">' +
          (pin ? '<span class="pinmark">★</span>' : '') +
          '<span class="nm">' + esc(p.name) + '</span>' +
          '<span class="id">' + esc(p.userId) + '</span>' +
          '<span class="ct">' + (p.count > 0 ? p.count + ' 条' : '还没记') + '</span>' +
          '</div>'
        );
      })
      .join('');
    list.onclick = (ev) => {
      const el = ev.target.closest('.dperson');
      if (!el) return;
      diarySelected = el.dataset.uid;
      renderDiary(s);
    };
  } else {
    for (const el of list.querySelectorAll('.dperson')) {
      el.classList.toggle('on', el.dataset.uid === diarySelected);
    }
  }

  // 右边时间线
  const person = people.find((p) => p.userId === diarySelected);
  const raw = (group.diaries && group.diaries[diarySelected]) || '';
  // 注意：这一段在**模板字符串**里，所有反斜杠都要写双份。
  //   \\r \\n \\s  →  渲染后才是 \r \n \s
  // 之前 \\r?\\n 转对了，但下面的 \\s 忘了转 —— 变成字母 s，
  // 正则 /^s*[-*]s+/ 谁都匹配不上，于是左边显示"3 条"、右边却说"还没有事件"。
  const events = raw
    .split(/\\r?\\n/)
    .map((line) => line.match(/^\\s*[-*]\\s+(\\d{2})-(\\d{2})\\s+(\\d{2}):(\\d{2})\\s+(.+)$/))
    .filter(Boolean)
    .map((m) => ({ key: m[1] + m[2] + m[3] + m[4], md: m[1] + '-' + m[2], t: m[3] + ':' + m[4], text: m[5] }))
    .sort((a, b) => b.key.localeCompare(a.key));

  let body = '<p class="hint">这个人还没有记下什么关键事件。</p>';
  if (events.length) {
    body = '<ul class="dtl">' + events.map((e) => {
      return '<li><time><b>' + esc(e.t) + '</b><span>' + esc(e.md) + '</span></time><p>' + esc(e.text) + '</p></li>';
    }).join('') + '</ul>';
  }
  detail.innerHTML =
    '<div class="dscroll">' +
    '<h3>' + esc(person ? person.name : diarySelected) + '</h3>' +
    '<div class="qq">QQ ' + esc(diarySelected) + '</div>' +
    body +
    '</div>';
}

function renderExtras(s) {
  const box = document.getElementById('extras');
  if (!box) return;
  const contrib = s.contributions || {};
  const sig = extrasSignature(contrib);

  // 结构没变：只刷新"展示型"字段，不碰用户正在操作的控件
  if (extrasBuilt && sig === extrasSig) {
    updateExtrasLive( contrib);
    return;
  }
  extrasSig = sig;
  extrasBuilt = true;

  const parts = [];

  for (const [id, data] of Object.entries(contrib)) {
    if (!data || typeof data !== 'object') continue;
    parts.push('<h2>' + esc(id) + ' · 连接与参数</h2><div class="panel">');

    // 连接状态 + 参数调节
    if (data.config || data.connection) {
      const c = data.config || {};
      const conn = data.connection || {};
      const merge = c.merge || {};
      parts.push('<div class="extrow">');
      // 这几个 tag 带 data-live-* 标记，结构不重建时由 updateExtrasLive 单独刷新
      parts.push(
        '<span class="tag ' + (conn.connected ? 'on' : 'off') + '" data-live="conn" data-id="' + esc(id) + '">' +
          (conn.connected ? '已连接' : '未连接') + '</span>',
      );
      if (c.adapter) parts.push('<span class="tag">' + esc(c.adapter) + '</span>');
      parts.push(
        '<span class="tag ' + (c.dryRun ? 'off' : 'on') + '" data-live="mode" data-id="' + esc(id) + '">' +
          (c.dryRun ? '只观察' : '真发') + '</span>',
      );
      if (merge.perMinute !== undefined) {
        parts.push('<span class="tag" data-live="rate" data-id="' + esc(id) + '">限流 ' + esc(merge.perMinute) + '/分</span>');
      }
      if (c.summarizeEvery !== undefined) {
        parts.push('<span class="tag" data-live="every" data-id="' + esc(id) + '">总结 每' + esc(c.summarizeEvery) + '轮</span>');
      }
      parts.push('</div>');
      // 参数调节：只有供给方声明了 apply（支持在线调参）才显示
      if (data._canApply) {
        // 模板字符串里 \\w 才不会被吃掉（单写会变成字母 w）
        const cid = 'tune-' + id.replace(/[^\\w-]/g, '_');
        parts.push('<div class="tunebox" id="' + cid + '">');
        parts.push('<div class="tunegrid">');
        // 主动插话频率
        parts.push(
          '<div class="tfield"><label>主动插话频率</label>' +
            '<div class="trow"><input type="range" data-k="perMinute" min="0" max="6" step="0.5" value="' +
            esc(merge.perMinute ?? 1) + '"><b class="tv">' + esc(merge.perMinute ?? 1) + '</b></div>' +
            '<div class="thint">每群每分钟最多主动说几次（0 = 不限，被 @ 不受限）</div></div>',
        );
        // 总结频率
        parts.push(
          '<div class="tfield"><label>总结频率</label>' +
            '<div class="trow"><input type="range" data-k="summarizeEvery" min="1" max="5" step="1" value="' +
            esc(c.summarizeEvery ?? 1) + '"><b class="tv">' + esc(c.summarizeEvery ?? 1) + '</b></div>' +
            '<div class="thint">每几轮真跑一次总结（1 = 每轮，情绪最鲜活；越大越省）</div></div>',
        );
        // 冷场抢跑
        parts.push(
          '<div class="tfield"><label>冷场抢跑（秒）</label>' +
            '<div class="trow"><input type="range" data-k="coldSec" min="5" max="180" step="5" value="' +
            esc(Math.round((c.coldSilenceMs ?? 30000) / 1000)) + '"><b class="tv">' +
            esc(Math.round((c.coldSilenceMs ?? 30000) / 1000)) + '</b></div>' +
            '<div class="thint">群里安静这么久后，下一句立刻触发</div></div>',
        );
        // 模式
        //
        // data-v 就是 dryRun 的值本身（'true'=只观察 / 'false'=真发），
        // 之前多绕了一层取反，导致"服务器说只观察、按钮说真发"。
        const dryVal = c.dryRun ? 'true' : 'false';
        parts.push(
          '<div class="tfield"><label>模式</label><div class="trow">' +
            '<button class="winbtn ' + (c.dryRun ? '' : 'on') + '" data-k="dryRun" data-v="' + dryVal + '">' +
            (c.dryRun ? '当前：只观察' : '当前：真发') + '</button>' +
            '</div><div class="thint">点一下切换（只观察 = 不发消息，只打印计划）</div></div>',
        );
        parts.push('</div>');
        parts.push(
          '<div class="tuneapply"><button class="applybtn" data-apply="' + esc(id) + '">应用</button>' +
            '<span class="tmsg"></span>' +
            '<span class="tfile">' + esc(data.liveConfigFile || '') + '</span></div>',
        );
        parts.push('</div>');
      }
    }

    // 会话表
    const sessions = data.sessions || [];
    if (sessions.length) {
      parts.push('<div class="k" style="margin:16px 0 8px">工作区会话</div>');
      parts.push('<table><thead><tr><th>会话</th><th>路由</th><th>消息</th><th>最近一条</th></tr></thead><tbody>');
      for (const x of sessions) {
        parts.push(
          '<tr><td class="mono">' + esc(x.key) + '</td>' +
            '<td>' + (x.routed ? '<span class="tag on">已配</span>' : '<span class="tag off">无</span>') + '</td>' +
            '<td>' + esc(x.count) + '</td>' +
            '<td class="trunc">' + esc(x.lastSender) + (x.lastAt ? ' <span class="k">' + fmtTime(x.lastAt) + '</span>' : '') +
            (x.lastText ? ' · ' + esc(x.lastText) : '') + '</td></tr>',
        );
      }
      parts.push('</tbody></table>');
    }

    // 最近消息
    const recent = data.recent || [];
    if (recent.length) {
      parts.push('<div class="k" style="margin:16px 0 8px">最近消息</div>');
      parts.push('<div class="extscroll"><table><thead><tr><th>时间</th><th>会话</th><th>发送人</th><th>内容 / 她的想法 / 回的</th></tr></thead><tbody>');
      for (const m of recent) {
        // 一条消息下面挂两行：它心里想的（thought）和它实际回的（reply）。
        // 这两个字段由 qq-kit 拿到 plan 后回填；没有就不显示，别占地方。
        const extra =
          (m.thought ? '<div class="thline"><span class="thtag">想</span>' + esc(m.thought) + '</div>' : '') +
          (m.reply ? '<div class="reline"><span class="retag">回</span>' + esc(String(m.reply).slice(0, 160)) + '</div>' : '');
        parts.push(
          '<tr><td class="mono">' + fmtTime(m.time) + '</td>' +
            '<td class="mono">' + esc(m.key) + '</td>' +
            '<td>' + esc(m.sender) + '</td>' +
            '<td class="trunc"><div>' + esc(m.text) + '</div>' + extra + '</td></tr>',
        );
      }
      parts.push('</tbody></table></div>');
    }

    parts.push('</div>');
  }

  box.innerHTML = parts.join('');
}

/**
 * 结构不重建时，只刷新纯展示的状态标签。
 * 不碰滑块、不碰按钮、不碰会话表和消息表 —— 那些重写会打断用户操作。
 */
function updateExtrasLive(contrib) {
  const box = document.getElementById('extras');
  if (!box) return;
  for (const [id, data] of Object.entries(contrib || {})) {
    if (!data || typeof data !== 'object') continue;
    const c = data.config || {};
    const conn = data.connection || {};
    const q = (live) => box.querySelector('[data-live="' + live + '"][data-id="' + id + '"]');

    const connEl = q('conn');
    if (connEl) {
      connEl.textContent = conn.connected ? '已连接' : '未连接';
      connEl.className = 'tag ' + (conn.connected ? 'on' : 'off');
    }
    const modeEl = q('mode');
    if (modeEl) {
      modeEl.textContent = c.dryRun ? '只观察' : '真发';
      modeEl.className = 'tag ' + (c.dryRun ? 'off' : 'on');
    }
    const rateEl = q('rate');
    if (rateEl && c.merge) rateEl.textContent = '限流 ' + c.merge.perMinute + '/分';
    const everyEl = q('every');
    if (everyEl && c.summarizeEvery !== undefined) everyEl.textContent = '总结 每' + c.summarizeEvery + '轮';
  }
}

// ── 时间窗切换（事件委托）──
//
// 以前是对 .winbtn 逐个 addEventListener，有两个坑：
//   ① 调参区块里的"真发/只观察"按钮也用了 .winbtn 且是动态渲染的，
//      重新渲染后监听就丢了，点了没反应；
//   ② 点时间窗时那句 querySelectorAll('.winbtn') 会把调参按钮的选中态也清掉。
// 现在只认带 data-win 的按钮，并且用委托，动态重建也不怕。
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('button[data-win]');
  if (!btn) return;
  starWindow = btn.getAttribute('data-win');
  document.querySelectorAll('button[data-win]').forEach((b) => b.classList.toggle('on', b === btn));
  tick();
});

// ── 外部贡献区块的交互（动态渲染，用事件委托）──
// 滑块拖动时更新数字
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el || el.tagName !== 'INPUT' || el.type !== 'range') return;
  const key = el.getAttribute('data-k');
  if (!key) return;
  const box = el.closest('.tfield');
  const out = box && box.querySelector('.tv');
  if (!out) return;
  let v = Number(el.value);
  if (key === 'perMinute') out.textContent = v === 0 ? '不限' : String(v);
  else if (key === 'coldSec') out.textContent = v + 's';
  else out.textContent = v === 1 ? '每轮' : String(v);
});
// 模式按钮：切换 dryRun，只改按钮状态，等点"应用"才提交
//
// data-v 直接存 dryRun 的值：'true'=只观察，'false'=真发。
// 点一下就是把当前值取反。
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('button[data-k="dryRun"]');
  if (!btn) return;
  const wasDry = btn.getAttribute('data-v') === 'true';
  const nowDry = !wasDry; // 取反
  btn.setAttribute('data-v', nowDry ? 'true' : 'false');
  btn.textContent = nowDry ? '当前：只观察' : '当前：真发';
  btn.classList.toggle('on', !nowDry); // "真发"才高亮
});
// 应用
document.addEventListener('click', async (e) => {
  const btn = e.target && e.target.closest && e.target.closest('button[data-apply]');
  if (!btn) return;
  const id = btn.getAttribute('data-apply');
  const box = btn.closest('.tunebox');
  const msg = box && box.querySelector('.tmsg');
  const patch = {};
  for (const el of box.querySelectorAll('input[data-k]')) {
    const k = el.getAttribute('data-k');
    const v = Number(el.value);
    if (k === 'perMinute') patch.merge = { ...(patch.merge || {}), perMinute: v };
    else if (k === 'summarizeEvery') patch.summarizeEvery = v;
    else if (k === 'coldSec') patch.coldSilenceMs = v * 1000;
  }
  const modeBtn = box.querySelector('button[data-k="dryRun"]');
  if (modeBtn) patch.dryRun = modeBtn.getAttribute('data-v') === 'true';

  btn.disabled = true;
  if (msg) { msg.textContent = '应用中…'; msg.classList.remove('err'); }
  try {
    const r = await fetch('/mood-kit/api/tune', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, patch }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
    if (msg) { msg.textContent = '已生效'; }
    tick();
    setTimeout(() => { if (msg) msg.textContent = ''; }, 2500);
  } catch (err) {
    if (msg) { msg.textContent = '失败：' + err.message; msg.classList.add('err'); }
  } finally {
    btn.disabled = false;
  }
});

async function tick() {
  let s;
  try {
    const r = await fetch('/mood-kit/api/state', { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error('HTTP ' + r.status + (body ? '：' + body.slice(0, 120) : ''));
    }
    s = await r.json();
    // 存一份最近的状态：切群标签时要重画，但不必重新请求
    window.__lastState = s;
  } catch (e) {
    document.getElementById('cards').innerHTML =
      '<div class="card" style="border:1px solid #1e2b3d;padding:12px 16px"><div class="k">取数据失败</div><div style="color:#f87171">' + esc(e.message) + '</div></div>';
    return;
  }
  renderMood(s);
  renderStars(s);
  renderPeople(s);
  renderDiary(s);
  renderExtras(s);
  renderStale(s);
  const pts = (s.moodHistory && s.moodHistory.points) || [];
  // 「情绪点」显示真·历史累计（含被 2000 上限裁掉的），不是当前存着几条。
  // 顺便把"当前留存"作为小字标出来，免得看到 2000 以为卡住了。
  const totalPts = Number(s.moodHistory && s.moodHistory.total) || pts.length;
  document.getElementById('cards').innerHTML = [
    ['情绪点', totalPts, pts.length < totalPts ? '历史累计 · 现存 ' + pts.length : '历史累计'],
    ['记住的人', (s.people && s.people.nodes && s.people.nodes.length) || 0, '记忆星系'],
    ['版本', 'v' + esc(s.version || ''), ''],
  ].map(([k, v, sub]) =>
    '<div class="statcard"><div class="k">' + k + '</div>' +
    '<div class="v">' + v + '</div>' +
    (sub ? '<div class="k">' + sub + '</div>' : '') + '</div>'
  ).join('');
}

tick();
setInterval(tick, 2000);
window.addEventListener('resize', () => tick());
</script>
</body>
</html>`;
}
