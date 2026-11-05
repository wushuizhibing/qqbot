/**
 * 个人日记页（/qq-kit/diary）。
 *
 * 独立的一个页面，不走 iframe 那套 —— 它是个"查人的地方"，
 * 跟情绪面板（看整体走势）不是一回事。
 *
 * 数据：读 <diaryRoot>/<群号>/<QQ号>.md。文件名就是号，所以名字改了也认得出是谁。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 转义 HTML。
 * @param {unknown} s
 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 扫一个群的日记目录，返回每个人的摘要。
 *
 * @param {string} root
 * @param {string} groupId
 * @param {{ roster?: Array<{ id?: string, name?: string }> }} [options]
 *   补全名单：群记忆里的人。有日记的用日记，没日记的也列出来（count 为 0），
 *   这样面板能看到全群，而不是"只有被记过事件的那几个"。
 * @returns {Array<{ userId: string, name: string, intro: string, count: number, last: number, hasDiary: boolean }>}
 */
export function listDiaryPeople(root, groupId, options = {}) {
  const dir = path.join(String(root ?? ''), String(groupId ?? ''));
  /** @type {Map<string, any>} */
  const byId = new Map();
  const hasDir = Boolean(root && groupId && fs.existsSync(dir));
  const files = hasDir ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')) : [];

  for (const name of files) {
    const file = path.join(dir, name);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const title = (text.match(/^#\s+(.+?)[（(]QQ\s+([^）)]+)[）)]/m) ?? []);
    const events = text.match(/^\s*[-*]\s+\d{2}-\d{2}\s+\d{2}:\d{2}/gm) ?? [];
    // 最后一条的行首时间戳，用来排序；解析失败就当 0
    const stamps = text.match(/^\s*[-*]\s+(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/gm) ?? [];
    let last = 0;
    const tail = stamps[stamps.length - 1];
    if (tail) {
      const m = tail.match(/(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
      if (m) {
        const now = new Date();
        let year = now.getFullYear();
        const probe = new Date(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]));
        if (probe.getTime() - now.getTime() > 31 * 24 * 3600 * 1000) year -= 1;
        last = new Date(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4])).getTime();
      }
    }
    byId.set(String(title[2] ?? path.basename(name, '.md')), {
      userId: String(title[2] ?? path.basename(name, '.md')),
      name: String(title[1] ?? path.basename(name, '.md')),
      intro: (text.match(/##\s*关于他\s*\n([\s\S]*?)(?:\n##\s|$)/) ?? [])[1]?.trim() ?? '',
      count: events.length,
      last,
      hasDiary: true,
    });
  }

  // 补全：群记忆里有、但还没攒出日记的人也要列出来。
  // 不然面板上只有寥寥几个人，看着像"漏了"，其实是他们还没触发过关键事件。
  for (const who of options.roster ?? []) {
    const id = String(who?.id ?? '').trim();
    const nm = String(who?.name ?? '').trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      userId: id,
      name: nm || id,
      intro: '',
      count: 0,
      last: 0,
      hasDiary: false,
      isOwner: Boolean(who?.isOwner),
    });
  }

  // 主人也算一次：不管有没有日记，只要号对上就标上
  const ownerId = String(options.ownerId ?? '').trim();
  if (ownerId) {
    const existing = byId.get(ownerId);
    if (existing) existing.isOwner = true;
    else {
      // 有日记但不在 roster 里的人（理论上不该发生），也补进来
      const fromRoster = (options.roster ?? []).find((w) => String(w?.id ?? '') === ownerId);
      if (fromRoster) {
        byId.set(ownerId, {
          userId: ownerId,
          name: String(fromRoster.name || ownerId),
          intro: '',
          count: 0,
          last: 0,
          hasDiary: false,
          isOwner: true,
        });
      }
    }
  }

  return [...byId.values()].sort((a, b) => {
    // 主人永远置顶 —— 管他有没有日记、最近说没说话
    // 发布版：不置顶
    // 有过事件的排前面（按最近更新）；剩下的按名字排
    if (a.hasDiary !== b.hasDiary) return a.hasDiary ? -1 : 1;
    if (a.hasDiary) return b.last - a.last;
    return a.name.localeCompare(b.name, 'zh');
  });
}

/**
 * 读单个人的日记全文。
 * @param {string} root
 * @param {string} groupId
 * @param {string} userId
 */
export function readDiary(root, groupId, userId) {
  const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  const file = path.join(String(root ?? ''), safe(groupId), `${safe(userId)}.md`);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 把日记正文渲染成时间线 HTML。
 * @param {string} text
 */
function renderTimeline(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const items = [];
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s+(.+)$/);
    if (!m) continue;
    items.push({
      // 排序键：月日时分拼一起，够用来排
      key: `${m[1]}${m[2]}${m[3]}${m[4]}`,
      md: `${m[1]}-${m[2]}`,
      hhmm: `${m[3]}:${m[4]}`,
      text: m[5],
    });
  }
  if (items.length === 0) return '<p class="empty">这个人还没有记下什么关键事件。</p>';
  // 新的放上面：翻日记先看最近发生的
  items.sort((a, b) => b.key.localeCompare(a.key));
  const rows = items.map(
    (e) => `<li class="ev"><time><b>${esc(e.hhmm)}</b><span>${esc(e.md)}</span></time><p>${esc(e.text)}</p></li>`,
  );
  return `<ol class="timeline">${rows.join('')}</ol>`;
}

/**
 * 渲染整个日记页。
 *
 * 交互方式：**一次把数据全塞进来，点击只在本地切换**。
 *
 * 以前每次点人都是一次整页请求（`?group=x&person=y`），刷新、闪一下、
 * 滚动位置也没了 —— 翻日记最忌讳这个。现在左栏点击只是换右边的内容。
 *
 * @param {{
 *   groups: Array<{ id: string, label: string, people: any[] }>,
 *   activeGroup?: string, activePerson?: any, content?: string,
 *   diaries?: Record<string, string>,   // "<群号>/<QQ号>" → 日记原文，给前端切换用
 * }} input
 */
export function renderDiaryHtml(input) {
  const groups = input?.groups ?? [];
  const activeGroup = input?.activeGroup ?? groups[0]?.id ?? '';
  const people = groups.find((g) => g.id === activeGroup)?.people ?? [];

  const tabs = groups
    .map(
      (g) =>
        `<a class="tab${g.id === activeGroup ? ' on' : ''}" data-group="${esc(g.id)}" href="/qq-kit/diary?group=${esc(g.id)}">${esc(g.label)}<em>${g.people.length}</em></a>`,
    )
    .join('');

  const list = people
    .map((p) => {
      const on = input?.activePerson?.userId === p.userId;
      const pin = false; // 发布版没有置顶
      const when = p.last ? new Date(p.last).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
      return `<a class="person${on ? ' on' : ''}${pin ? ' pinned' : ''}" data-person="${esc(p.userId)}" href="/qq-kit/diary?group=${esc(activeGroup)}&person=${esc(p.userId)}">
        ${pin ? '<span class="pinmark">★</span>' : ''}
        <span class="nm">${esc(p.name)}</span>
        <span class="id">${esc(p.userId)}</span>
        <span class="meta">${p.count} 条 · ${esc(when)}</span>
      </a>`;
    })
    .join('') || '<p class="empty">这个群还没有日记。等下一次自动更新。</p>';

  const detail = input?.activePerson
    ? `<div class="detail">
        <header>
          <h2>${esc(input.activePerson.name)}</h2>
          <span class="qqid">QQ ${esc(input.activePerson.userId)}</span>
        </header>
        <p class="intro">最近更新：${
          input.activePerson.last
            ? esc(new Date(input.activePerson.last).toLocaleString('zh-CN', { hour12: false }))
            : '—'
        }</p>
        ${renderTimeline(input.content ?? '')}
      </div>`
    : '<div class="detail"><p class="empty">左边选一个人，看他的时间线。</p></div>';

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>群友日记 · qq-kit</title>
<style>
  :root{--bg:#0a0e14;--panel:#111823;--line:#1e2b3d;--fg:#e8f0fa;--fg2:#8fa3bd;--fg3:#5a6b82;--accent:#38bdf8;--ok:#4ade80;--purple:#a78bfa}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--fg);font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;min-height:100vh}
  body::before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.45;
    background-image:linear-gradient(rgba(56,189,248,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(56,189,248,.03) 1px,transparent 1px);
    background-size:48px 48px;
    mask-image:radial-gradient(ellipse 90% 70% at 50% 0%,#000 20%,transparent 85%);
    -webkit-mask-image:radial-gradient(ellipse 90% 70% at 50% 0%,#000 20%,transparent 85%)}
  .wrap{position:relative;max-width:1180px;margin:0 auto;padding:34px 26px 60px}
  h1{font-size:26px;font-weight:800;display:flex;align-items:center;gap:12px}
  h1::before{content:"";width:5px;height:26px;background:var(--accent);box-shadow:0 0 14px rgba(56,189,248,.55)}
  h1 em{font-style:normal;font-size:13px;font-weight:500;color:var(--fg3);letter-spacing:2px}
  .tabs{display:flex;gap:8px;margin:20px 0 22px;flex-wrap:wrap}
  .tab{padding:7px 15px;border:1px solid var(--line);color:var(--fg2);text-decoration:none;font-size:13px;
    clip-path:polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,10px 100%,0 calc(100% - 10px));transition:.15s}
  .tab em{font-style:normal;margin-left:7px;color:var(--fg3);font-size:11px}
  .tab:hover{border-color:var(--accent);color:var(--fg)}
  .tab.on{background:rgba(56,189,248,.11);border-color:rgba(56,189,248,.45);color:var(--accent)}
  .cols{display:grid;grid-template-columns:280px 1fr;gap:20px;align-items:start}
  .list{display:flex;flex-direction:column;gap:6px}
  .person{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:11px 14px;border:1px solid var(--line);
    background:linear-gradient(160deg,rgba(22,32,46,.6),rgba(13,18,25,.7));text-decoration:none;color:inherit;
    clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,12px 100%,0 calc(100% - 12px));transition:.15s;
    position:relative}
  .person:hover{border-color:rgba(56,189,248,.45);background:rgba(56,189,248,.06)}
  .person.on{border-color:var(--accent);background:rgba(56,189,248,.10)}
  /* 主人置顶：金边 + 星标 */
  .person.pinned{border-color:rgba(251,191,36,.55);background:rgba(251,191,36,.07)}
  .person.pinned .nm{color:#fde68a}
  .person .pinmark{position:absolute;left:-1px;top:-1px;color:#fbbf24;font-size:9px;
    line-height:1;padding:2px 3px}
  .person .nm{font-size:14px;font-weight:700;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .person .id{font-size:11px;color:var(--fg3);font-family:Consolas,monospace;grid-row:2}
  .person .meta{font-size:11px;color:var(--fg3);grid-row:1/3;align-self:center;white-space:nowrap}
  .detail{border:1px solid var(--line);background:linear-gradient(165deg,rgba(17,24,35,.92),rgba(10,14,20,.94));
    padding:24px 28px;min-height:340px;clip-path:polygon(0 0,calc(100% - 18px) 0,100% 18px,100% 100%,18px 100%,0 calc(100% - 18px))}
  .detail header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
  .detail h2{font-size:21px}
  .qqid{font-family:Consolas,monospace;font-size:12px;color:var(--fg3);padding:2px 9px;border:1px solid var(--line)}
  .intro{font-size:12px;color:var(--fg3);margin:8px 0 20px}
  .timeline{list-style:none;display:flex;flex-direction:column;gap:2px}
  .ev{display:grid;grid-template-columns:88px 1fr;gap:14px;padding:9px 0;border-bottom:1px dashed rgba(30,43,61,.75)}
  .ev:last-child{border-bottom:0}
  .ev time{display:flex;flex-direction:column;font-family:Consolas,monospace;line-height:1.35}
  .ev time b{font-size:13px;color:var(--accent);font-weight:600}
  .ev time span{font-size:11px;color:var(--fg3)}
  .ev p{font-size:14px;line-height:1.6;color:var(--fg2)}
  .empty{color:var(--fg3);font-size:13px;padding:12px 0}
  .foot{margin-top:26px;font-size:12px;color:var(--fg3)}
  .foot code{color:var(--fg2);font-family:Consolas,monospace}
</style></head>
<body><div class="wrap">
  <h1>群友日记 <em>DIARY</em></h1>
  <div class="tabs">${tabs || '<span class="empty">还没有任何群</span>'}</div>
  <div class="cols">
    <div class="list">${list}</div>
    ${detail}
  </div>
  <div class="foot">按 QQ 号归档 · 只记关键事件（要求 / 冲突 / 承诺 / 重要信息）· 存在 <code>${esc(input?.root ?? '')}</code></div>
</div>
<script>
(function () {
  // 数据整包塞进页面：点击只在本地切换，不再整页刷新。
  var DATA = ${JSON.stringify(buildClientData(input)).replace(/</g, '\\u003c')};

  var $list = document.querySelector('.list');
  var $detail = document.querySelector('.detail');
  var $tabs = document.querySelector('.tabs');
  var current = { group: DATA.activeGroup, person: DATA.activePerson };

  /** 转义：历史内容原样渲染，但 HTML 得挡掉 */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 把日记原文渲染成时间线（新的在上） */
  function timeline(text) {
    var items = [];
    String(text || '').split(/\\r?\\n/).forEach(function (line) {
      var m = line.match(/^\\s*[-*]\\s+(\\d{2})-(\\d{2})\\s+(\\d{2}):(\\d{2})\\s+(.+)$/);
      if (!m) return;
      items.push({ key: m[1] + m[2] + m[3] + m[4], md: m[1] + '-' + m[2], t: m[3] + ':' + m[4], text: m[5] });
    });
    if (!items.length) return '<p class="empty">这个人还没有记下什么关键事件。</p>';
    items.sort(function (a, b) { return b.key < a.key ? -1 : b.key > a.key ? 1 : 0; });
    return '<ol class="timeline">' + items.map(function (e) {
      return '<li class="ev"><time><b>' + esc(e.t) + '</b><span>' + esc(e.md) + '</span></time><p>' + esc(e.text) + '</p></li>';
    }).join('') + '</ol>';
  }

  function fmt(ts) {
    if (!ts) return '—';
    var d = new Date(ts), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 右侧详情 */
  function renderDetail(person) {
    if (!person) {
      $detail.innerHTML = '<p class="empty">左边选一个人，看他的时间线。</p>';
      return;
    }
    var text = DATA.diaries[person.group + '/' + person.userId] || '';
    $detail.innerHTML =
      '<header><h2>' + esc(person.name) + '</h2>' +
      '<span class="qqid">QQ ' + esc(person.userId) + '</span></header>' +
      '<p class="intro">最近更新：' + esc(fmt(person.last)) + '</p>' +
      timeline(text);
    $detail.scrollTop = 0;
  }

  /** 左栏列表 */
  function renderList(groupId) {
    var g = DATA.groups.find(function (x) { return x.id === groupId; });
    var people = (g && g.people) || [];
    if (!people.length) {
      $list.innerHTML = '<p class="empty">这个群还没有日记。等下一次自动更新。</p>';
      return;
    }
    $list.innerHTML = people.map(function (p) {
      var on = current.person && current.person.userId === p.userId && current.group === groupId;
      return '<a class="person' + (on ? ' on' : '') + '" data-person="' + esc(p.userId) + '">' +
        '<span class="nm">' + esc(p.name) + '</span>' +
        '<span class="id">' + esc(p.userId) + '</span>' +
        '<span class="meta">' + p.count + ' 条 · ' + esc(fmt(p.last)) + '</span>' +
        '</a>';
    }).join('');
  }

  function selectPerson(groupId, userId) {
    var g = DATA.groups.find(function (x) { return x.id === groupId; });
    var p = g && g.people.find(function (x) { return x.userId === userId; });
    if (!p) return;
    current = { group: groupId, person: Object.assign({ group: groupId }, p) };
    renderList(groupId);
    renderDetail(current.person);
    // 地址栏跟着变，但**不刷新**：刷新键/收藏还能用
    history.replaceState(null, '', '/qq-kit/diary?group=' + encodeURIComponent(groupId) + '&person=' + encodeURIComponent(userId));
  }

  // 左栏：选人
  $list.addEventListener('click', function (ev) {
    var a = ev.target.closest('.person');
    if (!a) return;
    ev.preventDefault();
    selectPerson(current.group, a.getAttribute('data-person'));
  });

  // 顶部：切群
  $tabs.addEventListener('click', function (ev) {
    var a = ev.target.closest('.tab');
    if (!a) return;
    ev.preventDefault();
    var gid = a.getAttribute('data-group');
    Array.prototype.forEach.call($tabs.querySelectorAll('.tab'), function (x) {
      x.classList.toggle('on', x.getAttribute('data-group') === gid);
    });
    var g = DATA.groups.find(function (x) { return x.id === gid; });
    var first = g && g.people[0];
    current = first ? { group: gid, person: Object.assign({ group: gid }, first) } : { group: gid, person: null };
    renderList(gid);
    renderDetail(current.person);
    if (first) {
      history.replaceState(null, '', '/qq-kit/diary?group=' + encodeURIComponent(gid) + '&person=' + encodeURIComponent(first.userId));
    }
  });

  // 键盘：上下键在名单里走
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    var g = DATA.groups.find(function (x) { return x.id === current.group; });
    if (!g || !g.people.length) return;
    var i = g.people.findIndex(function (x) { return x.userId === (current.person && current.person.userId); });
    var n = ev.key === 'ArrowDown' ? Math.min(i + 1, g.people.length - 1) : Math.max(i - 1, 0);
    if (n === i) return;
    ev.preventDefault();
    selectPerson(current.group, g.people[n].userId);
  });
})();
</script>
</div></body></html>`;
}

/**
 * 前端要的数据包：群 → 人 → 日记原文。
 *
 * 一次给全，换来"点哪都不刷新"。日记本来就不大（单文件最多 300 条事件），
 * 整包传过去比每点一次发一次请求划算得多。
 *
 * @param {{ groups?: any[], diaries?: Record<string,string>, activeGroup?: string, activePerson?: any }} input
 */
function buildClientData(input) {
  return {
    groups: input?.groups ?? [],
    diaries: input?.diaries ?? {},
    activeGroup: input?.activeGroup ?? '',
    activePerson: input?.activePerson ?? null,
  };
}
