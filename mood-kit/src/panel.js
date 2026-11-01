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
   * 注意：强度格子要排除在外：它靠 .on1~.on5 的背景色表示"点亮了几格"，
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

  .starbox{display:flex;gap:22px;flex-wrap:wrap}
  .starcard{flex:1 1 340px;min-width:300px}
  #star{width:100%;height:300px;display:block}
  #people{width:100%;height:460px;display:block}
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
    transition:background .15s,box-shadow .15s}
  .plrow:hover{background:rgba(56,189,248,.05);box-shadow:inset 2px 0 0 var(--accent)}
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
      </div>
      <div class="starcard">
        <div class="k" style="margin-bottom:10px">记住的人</div>
        <div id="peopleList" class="peoplelist"></div>
      </div>
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
function galaxyLayout(nodes, w, h) {
  const cx = w / 2, cy = h / 2;
  const K = Math.min(w, h) * 0.42;
  const pts = nodes.map((n, i) => ({
    ...n,
    x: cx + (Number.isFinite(n.x) ? n.x : Math.cos((i / nodes.length) * Math.PI * 2)) * K * 0.6,
    y: cy + (Number.isFinite(n.y) ? n.y : Math.sin((i / nodes.length) * Math.PI * 2)) * K * 0.6,
    vx: 0, vy: 0,
  }));
  const ctr = { x: cx, y: cy };
  let temp = 1;
  for (let step = 0; step < 260; step += 1) {
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        let dx = pts[i].x - pts[j].x;
        let dy = pts[i].y - pts[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { d2 = 1; dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
        const d = Math.sqrt(d2);
        const rep = (2200 / d2) * (0.6 + (1 - pts[i].warmth) * 0.8);
        pts[i].vx += (dx / d) * rep; pts[i].vy += (dy / d) * rep;
        pts[j].vx -= (dx / d) * rep; pts[j].vy -= (dy / d) * rep;
      }
    }
    for (const p of pts) {
      const dx = ctr.x - p.x, dy = ctr.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      const target = K * (0.42 + (1 - p.warmth) * 0.55);
      const pull = (d - target) * 0.012;
      p.vx += (dx / d) * pull;
      p.vy += (dy / d) * pull;
    }
    for (const p of pts) {
      const lim = 12 * temp;
      const v = Math.hypot(p.vx, p.vy) || 1;
      const scale = Math.min(1, lim / v);
      p.x += p.vx * scale * 0.55;
      p.y += p.vy * scale * 0.55;
      p.vx *= 0.35; p.vy *= 0.35;
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
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;

  const groupIdx = {};
  let gi = 0;
  for (const p of nodes) if (!(p.group in groupIdx)) groupIdx[p.group] = gi++;

  g.strokeStyle = 'rgba(56,189,248,0.06)';
  g.lineWidth = 1;
  for (let x = 0; x < w; x += 34) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = 0; y < h; y += 34) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  for (const r of [0.3, 0.55, 0.8]) {
    g.beginPath();
    g.arc(cx, cy, Math.min(w, h) * r * 0.52, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(56,189,248,0.07)';
    g.stroke();
  }

  if (!nodes.length) {
    g.fillStyle = 'rgba(148,163,184,.55)';
    g.font = '12px ui-sans-serif,system-ui,sans-serif';
    g.textAlign = 'center';
    g.fillText('还没记住任何人', cx, cy);
    drawCore(g, cx, cy);
    return;
  }

  const pts = gal ? gal.pts : galaxyLayout(nodes, w, h);
  pts.forEach((p) => {
    const dx = p.x - cx, dy = p.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;
    const startX = cx + ux * 22, startY = cy + uy * 22;
    const endX = p.x - ux * 14, endY = p.y - uy * 14;
    const col = p.relation === 'owner' ? REL_COLORS.owner : (GROUP_COLORS[groupIdx[p.group] ?? 0] || REL_COLORS[p.relation] || '#64748b');
    g.beginPath();
    g.moveTo(startX, startY);
    g.lineTo(endX, endY);
    g.strokeStyle = col;
    g.globalAlpha = 0.22 + p.warmth * 0.55;
    g.lineWidth = 0.8 + p.warmth * 2.2;
    g.stroke();
    g.globalAlpha = 1;
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
  pts.forEach((p) => {
    const col = p.relation === 'owner' ? REL_COLORS.owner : (GROUP_COLORS[groupIdx[p.group] ?? 0] || REL_COLORS[p.relation] || '#64748b');
    const r = 5 + p.warmth * 6;
    const halo = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.6);
    halo.addColorStop(0, col + '55');
    halo.addColorStop(1, col + '00');
    g.beginPath();
    g.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2);
    g.fillStyle = halo;
    g.fill();
    g.beginPath();
    g.arc(p.x, p.y, r, 0, Math.PI * 2);
    g.fillStyle = col;
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,.35)';
    g.lineWidth = 1;
    g.stroke();
    const label = p.name.length > 9 ? p.name.slice(0, 9) + '…' : p.name;
    g.font = '600 11.5px ui-sans-serif,system-ui,sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(10,14,20,.9)';
    g.strokeText(label, p.x, p.y + r + 5);
    g.fillStyle = '#e8f0fa';
    g.fillText(label, p.x, p.y + r + 5);
  });
  drawCore(g, cx, cy);
}

function drawCore(g, cx, cy) {
  const hal = g.createRadialGradient(cx, cy, 0, cx, cy, 46);
  hal.addColorStop(0, 'rgba(56,189,248,.5)');
  hal.addColorStop(1, 'rgba(56,189,248,0)');
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
    if (!gal || gal.key !== String(nodes.length)) {
      gal = { key: String(nodes.length), pts: galaxyLayout(nodes, w, h) };
    }
    drawGalaxy(nodes, w, h);
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
    list.innerHTML = nodes.length
      ? nodes.map((p) => {
          const gs = p.groups || (p.group ? [p.group] : []);
          const gTag = gs.length > 1 ? '<span class="gtag" title="' + esc(gs.join('、')) + '">' + gs.length + ' 群</span>' : '';
          return '<div class="plrow">' +
            '<span class="dot" style="background:' + (REL_COLORS[p.relation] || '#64748b') + '"></span>' +
            '<span class="nm" title="' + esc(p.note) + '">' + esc(p.name) + '</span>' + gTag +
            '<span class="bar2"><i style="width:' + Math.round(p.warmth * 100) + '%"></i></span>' +
            '<span class="rel ' + p.relation + '">' + (REL_NAMES[p.relation] || p.relation) + '</span>' +
            '</div>';
        }).join('')
      : '<div class="empty">还没有人名记忆</div>';
  }
}

// ── 外部贡献区块（qq-kit 等插件提供）────────────────────
// 面板自己不知道有哪些聊天插件在跑，全靠它们注册的供给函数。
//
// 注意：这块里有用户正在操作的控件（滑块、"真发/只观察"按钮）。
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
        const cid = 'tune-' + id.replace(/[^\w-]/g, '_');
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
  } catch (e) {
    document.getElementById('cards').innerHTML =
      '<div class="card" style="border:1px solid #1e2b3d;padding:12px 16px"><div class="k">取数据失败</div><div style="color:#f87171">' + esc(e.message) + '</div></div>';
    return;
  }
  renderMood(s);
  renderStars(s);
  renderPeople(s);
  renderExtras(s);
  renderStale(s);
  const pts = (s.moodHistory && s.moodHistory.points) || [];
  document.getElementById('cards').innerHTML = [
    ['情绪点', pts.length, '历史累计'],
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
