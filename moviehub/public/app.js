/* ═══════════════ 观影中心 前端逻辑 ═══════════════ */
(() => {
  'use strict';

  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  const LS_RECENT = 'mh_recent';
  const LS_HISTORY = 'mh_history';

  const state = {
    sources: [],
    view: 'home',
    results: [],
    detail: null,      // { name, pic, ..., sources: [{id, name, vodId, lines}] }
    lines: [],         // 播放线路扁平化: [{srcId, srcName, flag, episodes:[{title,url}]}]
    lineIdx: 0,
    epIdx: 0,
    hls: null,
    saveTimer: 0,
    douban: { type: 'movie', tag: '热门', items: [] },
  };

  const DOUBAN_TYPES = [{ k: 'movie', n: '电影' }, { k: 'tv', n: '剧集 / 综艺' }];
  const DOUBAN_TAGS = {
    movie: ['热门', '最新', '豆瓣高分', '冷门佳片', '经典'],
    tv: ['热门', '国产剧', '美剧', '日剧', '韩剧', '日本动画', '综艺'],
  };

  /* ─────────── 工具 ─────────── */

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const imgUrl = (u, srcId) => {
    if (!u) return '';
    let s = '/api/img?u=' + encodeURIComponent(u);
    const src = state.sources.find((x) => x.id === srcId);
    if (src) s += '&ref=' + encodeURIComponent(src.api);
    return s;
  };

  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t.classList.add('hidden'), ms || 2600);
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  function lsGet(key, def) {
    try { return JSON.parse(localStorage.getItem(key)) || def; } catch (e) { return def; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 忽略 */ }
  }

  /* ─────────── 视图切换 ─────────── */

  function show(view) {
    state.view = view;
    ['home', 'search', 'detail', 'player', 'music', 'cat'].forEach((v) => {
      $('#view-' + v).classList.toggle('hidden', v !== view);
    });
    window.scrollTo({ top: 0 });
    if (view !== 'player') stopPlayer();
  }
  window.__mhShow = show;
  window.__mhOpenItem = openItem;

  /* ─────────── 首页 ─────────── */

  async function renderHome() {
    show('home');
    const el = $('#view-home');
    const history = lsGet(LS_HISTORY, []).slice(0, 14);
    const recent = lsGet(LS_RECENT, []).slice(0, 10);

    let html = '<div class="section-title">豆瓣热榜<span class="sub">数据来自豆瓣 · 点击直接在片库中播放</span></div><div id="doubanSection"></div>';
    if (history.length) {
      html += '<div class="section-title">继续观看<span class="sub">从上次离开的地方继续</span></div><div class="hscroll" id="histRow"></div>';
    }
    if (recent.length) {
      html += '<div class="section-title">最近搜索</div><div class="chips" id="recentChips"></div>';
    }
    html += '<div class="section-title">最新入库</div><div id="latestBox"><div class="loading"><div class="spinner"></div>正在加载片库…</div></div>';
    el.innerHTML = html;

    renderDouban();

    // 继续观看
    if (history.length) {
      $('#histRow').innerHTML = history.map((h, i) => cardHtml({
        name: h.name, pic: h.pic, remarks: h.epTitle ? ('看到 ' + h.epTitle) : '',
      }, h.sources && h.sources.length > 1 ? h.sources.length : 0, `data-hist="${i}"`)).join('');
      $$('#histRow .card').forEach((c) => c.addEventListener('click', () => {
        const h = history[Number(c.dataset.hist)];
        resumeHistory(h);
      }));
    }
    // 最近搜索
    if (recent.length) {
      $('#recentChips').innerHTML = recent.map((k) =>
        `<span class="chip" data-kw="${esc(k)}">${esc(k)}</span>`).join('');
      $$('#recentChips .chip').forEach((c) => c.addEventListener('click', () => doSearch(c.dataset.kw)));
    }
    // 最新入库
    try {
      const r = await fetch('/api/latest?pg=1');
      const j = await r.json();
      if (!j.items || !j.items.length) throw new Error(j.error || '空');
      $('#latestBox').innerHTML = '<div class="grid">' + j.items.map((it, i) =>
        cardHtml(it, 0, `data-idx="${i}"`)).join('') + '</div>';
      bindCards($('#latestBox .grid'), j.items);
    } catch (e) {
      $('#latestBox').innerHTML = `<div class="empty">片库加载失败：${esc(e.message)}<br>请检查网络或稍后重试</div>`;
    }
  }

  function cardHtml(item, multi, extraAttr) {
    const srcId = item.source || (item.sources && item.sources[0] && item.sources[0].id);
    let visual;
    if (item.pic) {
      visual = `<img src="${imgUrl(item.pic, srcId)}" alt="" loading="lazy" onerror="this.parentNode.innerHTML='<div class=&quot;noimg&quot;>${esc(String(item.name || '影').charAt(0))}</div>'">`;
    } else {
      // 列表接口不带海报：用片名首字 + 由片名哈希生成的渐变色，比空白占位观感好
      let h = 0;
      const nm = String(item.name || '影');
      for (let i = 0; i < nm.length; i += 1) h = (h * 31 + nm.charCodeAt(i)) % 360;
      visual = `<div class="noimg" style="background:linear-gradient(135deg,hsl(${h},45%,28%),hsl(${(h + 60) % 360},50%,18%));font-size:34px;font-weight:700;color:rgba(255,255,255,.85)">${esc(nm.charAt(0))}</div>`;
    }
    const badge = multi > 1 ? `<span class="badge multi">${multi} 源</span>` : (item.remarks ? '' : '');
    return `<div class="card" ${extraAttr || ''}>
      <div class="poster">${visual}${badge}</div>
      <div class="info">
        <div class="name">${esc(item.name)}</div>
        <div class="remarks">${esc(item.remarks || item.typeName || '')}</div>
      </div>
    </div>`;
  }

  function bindCards(box, items) {
    state._cardItems = items;
    $$('.card', box).forEach((c) => {
      if (c.dataset.bound) return;
      c.dataset.bound = '1';
      c.addEventListener('click', () => openItem(items[Number(c.dataset.idx)]));
    });
  }

  /* ─────────── 豆瓣热榜 ─────────── */

  async function renderDouban() {
    const box = $('#doubanSection');
    if (!box) return;
    const d = state.douban;
    const typeTabs = DOUBAN_TYPES.map((t) =>
      `<span class="tab-btn ${t.k === d.type ? 'active' : ''}" data-t="${t.k}">${t.n}</span>`).join('');
    const tagChips = DOUBAN_TAGS[d.type].map((tg) =>
      `<span class="chip tag-chip ${tg === d.tag ? 'active' : ''}" data-g="${esc(tg)}">${esc(tg)}</span>`).join('');
    box.innerHTML = `
      <div class="douban-bar">
        <div class="tab-group">${typeTabs}</div>
        <div class="chips">${tagChips}</div>
      </div>
      <div id="doubanGrid"><div class="loading"><div class="spinner"></div>正在获取豆瓣${esc(d.tag)}榜单…</div></div>`;
    $$('#doubanSection .tab-btn').forEach((b) => b.addEventListener('click', () => {
      if (state.douban.type === b.dataset.t) return;
      state.douban.type = b.dataset.t;
      state.douban.tag = DOUBAN_TAGS[b.dataset.t][0];
      renderDouban();
    }));
    $$('#doubanSection .tag-chip').forEach((c) => c.addEventListener('click', () => {
      if (state.douban.tag === c.dataset.g) return;
      state.douban.tag = c.dataset.g;
      renderDouban();
    }));
    try {
      const r = await fetch('/api/douban?type=' + d.type + '&tag=' + encodeURIComponent(d.tag) + '&limit=24');
      const j = await r.json();
      if (!j.items || !j.items.length) throw new Error(j.error || '榜单为空');
      state.douban.items = j.items;
      renderDoubanCards();
    } catch (e) {
      $('#doubanGrid').innerHTML = `<div class="empty">豆瓣热榜获取失败：${esc(e.message)}<br>不影响搜索与播放，可切换标签重试</div>`;
    }
  }

  function renderDoubanCards() {
    const box = $('#doubanGrid');
    if (!box) return;
    box.innerHTML = '<div class="grid">' + state.douban.items.map((it, i) => {
      let visual;
      if (it.cover) {
        visual = `<img src="/api/img?u=${encodeURIComponent(it.cover)}&ref=${encodeURIComponent('https://m.douban.com/')}" alt="" loading="lazy" onerror="this.parentNode.innerHTML='<div class=&quot;noimg&quot;>${esc(String(it.title || '影').charAt(0))}</div>'">`;
      } else {
        visual = `<div class="noimg" style="font-size:30px">🎬</div>`;
      }
      const rate = it.rate ? `<span class="rate">⭐ ${it.rate}</span>` : '';
      return `<div class="card" data-di="${i}">
        <div class="poster">${visual}${rate}</div>
        <div class="info">
          <div class="name">${esc(it.title)}</div>
          <div class="remarks">${esc(it.year || it.subtitle || '')}</div>
        </div>
      </div>`;
    }).join('') + '</div>';
    $$('#doubanGrid .card').forEach((c) => c.addEventListener('click', () => {
      openDouban(state.douban.items[Number(c.dataset.di)]);
    }));
  }

  /** 点击豆瓣榜单影片：先在片库中定位，命中直接播，未命中退回搜索结果 */
  async function openDouban(item) {
    if (!item) return;
    toast('正在片库中定位《' + item.title + '》…');
    let items = [];
    try {
      items = await searchApi(item.title);
    } catch (e) { /* 忽略，走搜索视图 */ }
    const norm = (s) => String(s || '').replace(/[\s:：·—\-—_()（）[\]【】]/g, '').toLowerCase();
    const key = norm(item.title);
    const best = items.find((x) => norm(x.name) === key) ||
      items.find((x) => norm(x.name).includes(key) || key.includes(norm(x.name)));
    if (best) {
      showDetail(best);
      toast('《' + best.name + '》· ' + best.sources.length + ' 个源可播');
    } else {
      doSearch(item.title);
      toast('豆瓣在榜，片库未直接命中——已为你展示搜索结果');
    }
  }

  /* ─────────── 搜索 ─────────── */

  async function searchApi(wd, src) {
    const r = await fetch('/api/search?wd=' + encodeURIComponent(wd) + (src ? '&src=' + encodeURIComponent(src) : ''));
    const j = await r.json();
    return j.items || [];
  }

  async function doSearch(kw, src) {
    kw = (kw || '').trim();
    if (!kw) return;
    $('#searchInput').value = kw;
    show('search');
    const el = $('#view-search');
    el.innerHTML = `<div class="section-title">搜索“${esc(kw)}”</div><div class="loading"><div class="spinner"></div>正在聚合 ${state.sources.length} 个数据源…</div>`;

    // 记录最近搜索
    const recent = lsGet(LS_RECENT, []).filter((k) => k !== kw);
    recent.unshift(kw);
    lsSet(LS_RECENT, recent.slice(0, 10));

    try {
      state.results = await searchApi(kw, src);
      const j = { total: state.results.length, hitSources: 0, sourceCount: state.sources.length };
      if (!state.results.length) {
        el.innerHTML = `<div class="section-title">搜索“${esc(kw)}”</div>
          <div class="empty">没有找到相关影片<br><br>试试：① 换更短的关键词（如片名主干）② 顶部切换单个数据源 ③ 稍后再试（部分源有频控）</div>`;
        return;
      }
      const head = `<div class="section-title">搜索“${esc(kw)}”<span class="sub">${j.total} 个结果</span></div>`;
      el.innerHTML = head + '<div class="grid">' + state.results.map((it, i) =>
        cardHtml(it, it.sources.length, `data-idx="${i}"`)).join('') + '</div>';
      bindCards($('.grid', el), state.results);
    } catch (e) {
      el.innerHTML = `<div class="section-title">搜索“${esc(kw)}”</div><div class="empty">搜索失败：${esc(e.message)}</div>`;
    }
  }

  /* ─────────── 详情 ─────────── */

  async function openItem(item) {
    if (!item) return;
    // 来自“最新入库”的卡片没有 lines，需要拉详情
    if (!item.sources || !item.sources.length) {
      show('detail');
      $('#view-detail').innerHTML = '<div class="loading"><div class="spinner"></div>正在加载详情…</div>';
      try {
        const r = await fetch(`/api/detail?src=${encodeURIComponent(item.source)}&id=${encodeURIComponent(item.vodId)}`);
        const j = await r.json();
        if (j.error) throw new Error(j.error);
        item = { name: j.name, pic: j.pic, remarks: j.remarks, content: j.content, year: j.year, area: j.area, actor: j.actor, director: j.director, typeName: j.typeName, sources: [{ id: j.source, name: j.sourceName, vodId: j.vodId, lines: j.lines }] };
      } catch (e) {
        $('#view-detail').innerHTML = `<div class="empty">详情加载失败：${esc(e.message)}</div>`;
        return;
      }
    }
    showDetail(item);
  }

  function showDetail(item) {
    state.detail = item;
    state.lineIdx = 0;
    state.epIdx = 0;
    // 扁平化所有线路
    state.lines = [];
    (item.sources || []).forEach((s) => {
      (s.lines || []).forEach((l) => state.lines.push({ srcId: s.id, srcName: s.name, flag: l.flag, episodes: l.episodes }));
    });
    show('detail');
    const d = item;
    const el = $('#view-detail');
    const img = d.pic
      ? `<img src="${imgUrl(d.pic, d.sources && d.sources[0] && d.sources[0].id)}" alt="" onerror="this.style.display='none'">`
      : '<div style="padding:60px 0;text-align:center;color:var(--text-dim)">🎬</div>';
    const metas = [d.year, d.area, d.typeName, d.remarks].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('');
    el.innerHTML = `
      <button class="backbtn" id="detailBack">← 返回</button>
      <div class="detail">
        <div class="poster">${img}</div>
        <div class="body">
          <h1>${esc(d.name)}</h1>
          <div class="meta">${metas}</div>
          ${d.actor ? `<div class="meta"><span>主演：${esc(d.actor)}</span></div>` : ''}
          <div class="plot">${esc(d.content || '暂无简介')}</div>
          <div class="section-title" style="margin-top:0">播放线路<span class="sub">${state.lines.length} 条 · ${(d.sources || []).length} 个源</span></div>
          <div class="line-tabs" id="lineTabs"></div>
          <div class="ep-grid" id="epGrid"></div>
        </div>
      </div>`;
    $('#detailBack').addEventListener('click', () => back());
    renderLineTabs();
  }

  function renderLineTabs() {
    const box = $('#lineTabs');
    if (!box) return;
    box.innerHTML = state.lines.map((l, i) =>
      `<span class="line-tab ${i === state.lineIdx ? 'active' : ''}" data-i="${i}">${esc(l.srcName)} · ${esc(l.flag)}</span>`).join('');
    $$('.line-tab', box).forEach((t) => t.addEventListener('click', () => {
      state.lineIdx = Number(t.dataset.i);
      state.epIdx = 0;
      renderLineTabs();
      renderEps();
    }));
    renderEps();
  }

  function renderEps() {
    const box = $('#epGrid');
    if (!box) return;
    const line = state.lines[state.lineIdx];
    if (!line) { box.innerHTML = ''; return; }
    const eps = line.episodes;
    box.innerHTML = eps.map((ep, i) => {
      const label = ep.title || (eps.length === 1 ? '正片' : '第' + (i + 1) + '集');
      return `<span class="ep ${i === state.epIdx ? 'active' : ''}" data-i="${i}">${esc(label)}</span>`;
    }).join('');
    $$('.ep', box).forEach((b) => b.addEventListener('click', () => {
      state.epIdx = Number(b.dataset.i);
      startPlay();
    }));
  }

  /* ─────────── 播放 ─────────── */

  function stopPlayer() {
    if (state.hls) { try { state.hls.destroy(); } catch (e) { /* 忽略 */ } state.hls = null; }
    clearInterval(state.saveTimer);
  }

  function startPlay() {
    const item = state.detail;
    const line = state.lines[state.lineIdx];
    if (!item || !line) return;
    const ep = line.episodes[state.epIdx];
    if (!ep) { toast('该集不存在'); return; }
    const epLabel = ep.title || (line.episodes.length === 1 ? '正片' : '第' + (state.epIdx + 1) + '集');

    show('player');
    const el = $('#view-player');
    el.innerHTML = `
      <div class="player-head">
        <button class="backbtn" id="playerBack" style="margin-bottom:0">← 返回</button>
        <div class="t">${esc(item.name)} <span style="font-size:13px;color:var(--text-dim);font-weight:400">${esc(epLabel)}</span></div>
        <div class="src">${esc(line.srcName)} · ${esc(line.flag)}</div>
      </div>
      <div class="player-wrap"><video id="video" controls autoplay playsinline></video></div>
      <div class="player-eps"><div class="label">选集（当前线路 ${state.lineIdx + 1}/${state.lines.length}）</div><div class="ep-grid" id="pEpGrid"></div></div>`;
    $('#playerBack').addEventListener('click', () => back());

    // 选集
    const g = $('#pEpGrid');
    g.innerHTML = line.episodes.map((e2, i) => {
      const label = e2.title || (line.episodes.length === 1 ? '正片' : '第' + (i + 1) + '集');
      return `<span class="ep ${i === state.epIdx ? 'active' : ''}" data-i="${i}">${esc(label)}</span>`;
    }).join('');
    $$('.ep', g).forEach((b) => b.addEventListener('click', () => {
      state.epIdx = Number(b.dataset.i);
      startPlay();
    }));

    // 记录历史
    saveHistory(item, line, epLabel, 0, 0);

    const video = $('#video');
    const ref = state.sources.find((s) => s.id === line.srcId);
    const referer = ref ? ref.api : '';
    const playUrl = '/api/play?url=' + encodeURIComponent(ep.url) + '&ref=' + encodeURIComponent(referer);

    // 续播
    const hist = lsGet(LS_HISTORY, []).find((h) => h.key === histKey(item) && h.epUrl === ep.url);
    video.addEventListener('loadedmetadata', () => {
      if (hist && hist.pos && hist.dur && hist.pos > 20 && hist.pos < video.duration - 20) {
        video.currentTime = hist.pos;
        toast(`已从 ${fmtTime(hist.pos)} 继续播放`);
      }
    }, { once: true });

    if (/\.m3u8(\?|$)/i.test(ep.url)) {
      if (window.Hls && Hls.isSupported()) {
        const hls = new Hls({
          maxBufferLength: 30,
          manifestLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: 2,
          fragLoadingTimeOut: 25000,
          levelLoadingMaxRetry: 3,
        });
        state.hls = hls;
        hls.loadSource(playUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (evt, data) => {
          if (data.fatal) {
            console.warn('[hls] 致命错误', data.details, data);
            fallbackLine('播放出错：' + (data.details || 'unknown'));
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = playUrl;
      } else {
        $('.player-wrap', el).innerHTML = '<div class="player-err">当前浏览器不支持 HLS 播放<br>请使用 Chrome / Edge / Safari，或在电视上打开</div>';
        return;
      }
    } else {
      video.src = ep.url; // mp4 等直链可直接播
    }

    // 播放进度保存
    clearInterval(state.saveTimer);
    state.saveTimer = setInterval(() => {
      if (video.duration) saveHistory(item, line, epLabel, video.currentTime, video.duration, true);
    }, 5000);

    // 自动下一集
    video.onended = () => {
      if (state.epIdx + 1 < line.episodes.length) {
        state.epIdx += 1;
        startPlay();
      } else if (state.lineIdx + 1 < state.lines.length) {
        // 当前线路播完，不自动跨源
      } else {
        toast('本线路已播放完毕');
      }
    };
    video.onerror = () => { if (!state.hls) fallbackLine('视频加载失败'); };
  }

  /** 当前线路失败时自动尝试下一条线路 */
  function fallbackLine(reason) {
    if (state._fallingBack) return;
    state._fallingBack = true;
    if (state.lineIdx + 1 < state.lines.length) {
      state.lineIdx += 1;
      state.epIdx = 0;
      toast(reason + '，自动切换到：' + state.lines[state.lineIdx].srcName);
      setTimeout(() => { state._fallingBack = false; startPlay(); }, 600);
    } else {
      state._fallingBack = false;
      const el = $('#view-player');
      if (el && !$('.player-err', el)) {
        $('.player-wrap', el).innerHTML = `<div class="player-err">${esc(reason)}<br>所有线路都尝试失败了<br><br>建议：返回换一部，或稍后再试（部分源有频控）</div>`;
      }
    }
  }

  function histKey(item) {
    return (item.sources[0] && item.sources[0].id) + '|' + item.name;
  }

  function saveHistory(item, line, epLabel, pos, dur, silent) {
    const key = histKey(item);
    const ep = line.episodes[state.epIdx];
    const list = lsGet(LS_HISTORY, []).filter((h) => h.key !== key);
    list.unshift({
      key, name: item.name, pic: item.pic, epTitle: epLabel, epUrl: ep.url,
      sources: item.sources.map((s) => ({ id: s.id, name: s.name, vodId: s.vodId, lines: s.lines })),
      lineIdx: state.lineIdx, epIdx: state.epIdx, pos, dur, t: Date.now(),
    });
    lsSet(LS_HISTORY, list.slice(0, 30));
    if (!silent) { /* 首播不提示 */ }
  }

  function resumeHistory(h) {
    // 用历史记录里的完整源信息还原详情
    const item = { name: h.name, pic: h.pic, remarks: h.epTitle, content: '', sources: h.sources };
    showDetail(item);
    state.lineIdx = Math.min(h.lineIdx || 0, state.lines.length - 1);
    state.epIdx = h.epIdx || 0;
    renderLineTabs();
    startPlay();
  }

  /* ─────────── 返回 ─────────── */

  function back() {
    stopPlayer();
    if (state.view === 'player') {
      // 回到详情
      if (state.detail) { showDetail(state.detail); renderLineTabs(); return; }
      renderHome();
      return;
    }
    if (state.view === 'detail') { renderHome(); return; }
    renderHome();
  }

  /* ─────────── 启动 ─────────── */

  async function init() {
    try {
      const r = await fetch('/api/sources');
      const j = await r.json();
      state.sources = j.sources || [];
      const sel = $('#srcSelect');
      state.sources.forEach((s) => {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name;
        sel.appendChild(o);
      });
    } catch (e) {
      toast('源列表加载失败，请确认服务已启动');
    }

    $('#searchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      doSearch($('#searchInput').value, $('#srcSelect').value);
    });
    $('#brand').addEventListener('click', () => renderHome());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.view !== 'home') back();
    });
    renderHome();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
