/* ═══════════════ 分类浏览 前端逻辑 ═══════════════ */
(() => {
  'use strict';

  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  const LS_SRC = 'mh_cat_src';

  const state = {
    src: localStorage.getItem(LS_SRC) || '',
    types: [],        // [{id, pid, name, n}]
    groups: [],       // [{pid, name, items:[type]}]
    top: [],
    version: 0,
    done: false,
    pollTimer: 0,
    typeId: '',       // 当前分类
    typeName: '',
    page: 1,
    pagecount: 1,
    total: 0,
    year: '',
    by: '',
    items: [],
    loading: false,
  };

  const YEARS = ['', '2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018', '2015', '2010', '2005', '2000', '90年代', '80年代'];
  const ORDERS = [
    { v: '', n: '最新' },
    { v: 'hits', n: '最热' },
    { v: 'score', n: '评分' },
    { v: 'up', n: '最近更新' },
  ];

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function toast(msg, ms) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t.classList.add('hidden'), ms || 2600);
  }

  const fmtNum = (n) => (n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(n || 0));

  async function api(path) {
    const r = await fetch(path);
    const j = await r.json().catch(() => ({}));
    if (!r.ok && j.error) throw new Error(j.error);
    return j;
  }

  /* ─────────── 视图 ─────────── */

  function showCat() {
    ['home', 'search', 'detail', 'player', 'music', 'cat'].forEach((v) => {
      const el = $('#view-' + v);
      if (el) el.classList.toggle('hidden', v !== 'cat');
    });
    buildShell();
    if (!state.types.length) loadClasses();
    else renderAll();
  }

  function buildShell() {
    const view = $('#view-cat');
    if (view.dataset.built) return;
    view.dataset.built = '1';
    view.innerHTML = `
      <div class="cat-wrap">
        <aside class="cat-side">
          <div class="cat-side-head">
            <span>分类</span>
            <select id="catSrc" class="cat-src" title="选择浏览源"></select>
          </div>
          <div class="cat-tree" id="catTree"><div class="cat-loading">分类加载中…</div></div>
        </aside>
        <div class="cat-main">
          <div class="cat-bar">
            <div class="cat-title" id="catTitle">全部</div>
            <div class="cat-filters">
              <select id="catYear" class="cat-sel">${YEARS.map((y) => `<option value="${y}">${y || '全部年份'}</option>`).join('')}</select>
              <select id="catBy" class="cat-sel">${ORDERS.map((o) => `<option value="${o.v}">${o.n}</option>`).join('')}</select>
            </div>
          </div>
          <div class="cat-meta" id="catMeta"></div>
          <div class="cat-grid" id="catGrid"><div class="cat-loading">加载中…</div></div>
          <div class="cat-pager" id="catPager"></div>
        </div>
      </div>`;
    $('#catSrc').addEventListener('change', () => {
      state.src = $('#catSrc').value;
      localStorage.setItem(LS_SRC, state.src);
      state.types = []; state.groups = []; state.top = []; state.typeId = '';
      loadClasses();
    });
    $('#catYear').addEventListener('change', () => { state.year = $('#catYear').value; state.page = 1; loadBrowse(); });
    $('#catBy').addEventListener('change', () => { state.by = $('#catBy').value; state.page = 1; loadBrowse(); });
  }

  /* ─────────── 数据 ─────────── */

  async function loadClasses() {
    const tree = $('#catTree');
    tree.innerHTML = '<div class="cat-loading">正在发现分类树…</div>';
    try {
      const j = await api('/api/classes' + (state.src ? '?src=' + encodeURIComponent(state.src) : ''));
      state.src = j.src;
      state.types = j.types || [];
      state.groups = j.groups || [];
      state.top = j.top || [];
      state.version = j.version || 1;
      state.done = !!j.done;
      // 源下拉
      const sel = $('#catSrc');
      sel.innerHTML = '';
      const opts = await api('/api/sources').catch(() => ({ sources: [] }));
      opts.sources.forEach((s) => {
        const o = document.createElement('option');
        o.value = s.id; o.textContent = s.name;
        if (s.id === state.src) o.selected = true;
        sel.appendChild(o);
      });
      renderTree();
      // 默认选第一个有内容的分组
      const first = (state.groups[0] && state.groups[0].items[0]) || state.top[0];
      if (first) selectType(first.id, first.name);
      else renderAll();
      startPoll();
    } catch (e) {
      tree.innerHTML = `<div class="cat-empty">分类加载失败：${esc(e.message)}<br><button class="btn-primary" id="catRetry">重试</button></div>`;
      const r = $('#catRetry');
      if (r) r.addEventListener('click', loadClasses);
    }
  }

  /** 后台补全轮询：version 变了就刷新树（保留选中项），完成后停止 */
  function startPoll() {
    clearInterval(state.pollTimer);
    if (state.done) return;
    state.pollTimer = setInterval(async () => {
      if (state.loading) return;
      try {
        const j = await api('/api/classes?src=' + encodeURIComponent(state.src));
        if (!j.version || j.version === state.version) {
          if (j.done) { state.done = true; clearInterval(state.pollTimer); renderTree(); }
          return;
        }
        state.types = j.types || [];
        state.groups = j.groups || [];
        state.top = j.top || [];
        state.version = j.version;
        if (j.done) { state.done = true; clearInterval(state.pollTimer); }
        renderTree();
      } catch (e) { /* 网络抖动，下一轮再试 */ }
    }, 4000);
  }

  function renderTree() {
    const tree = $('#catTree');
    const nodeBtn = (t) => `
      <button class="cat-node ${String(t.id) === String(state.typeId) ? 'active' : ''}" data-id="${esc(t.id)}" data-name="${esc(t.name)}">
        <span>${esc(t.name)}</span>
      </button>`;
    const groups = state.groups.map((g) => `
      <div class="cat-group">
        <div class="cat-group-name">${esc(g.name)}</div>
        ${g.items.map(nodeBtn).join('')}
      </div>`).join('');
    const topHtml = state.top.length ? `
      <div class="cat-group">
        <div class="cat-group-name">其他</div>
        ${state.top.map(nodeBtn).join('')}
      </div>` : '';
    const status = state.done ? '' : '<div class="cat-tree-status">分类补全中…</div>';
    tree.innerHTML = groups + topHtml + status;
    $$('#catTree .cat-node').forEach((b) => b.addEventListener('click', () => {
      selectType(b.dataset.id, b.dataset.name);
    }));
  }

  function selectType(id, name) {
    state.typeId = String(id);
    state.typeName = name;
    state.page = 1;
    $$('#catTree .cat-node').forEach((b) => b.classList.toggle('active', b.dataset.id === state.typeId));
    loadBrowse();
  }

  async function loadBrowse() {
    if (state.loading) return;
    state.loading = true;
    const grid = $('#catGrid');
    grid.innerHTML = '<div class="cat-loading">加载中…</div>';
    $('#catPager').innerHTML = '';
    try {
      let url = '/api/browse?src=' + encodeURIComponent(state.src) + '&pg=' + state.page;
      if (state.typeId) url += '&t=' + encodeURIComponent(state.typeId);
      if (state.year) url += '&year=' + encodeURIComponent(state.year);
      if (state.by) url += '&by=' + encodeURIComponent(state.by);
      const j = await api(url);
      state.items = j.items || [];
      state.page = j.page || 1;
      state.pagecount = j.pagecount || 1;
      state.total = j.total || 0;
      if (j.typeName) state.typeName = j.typeName;
      renderAll();
    } catch (e) {
      grid.innerHTML = `<div class="cat-empty">加载失败：${esc(e.message)}</div>`;
    }
    state.loading = false;
  }

  /* ─────────── 渲染 ─────────── */

  function renderAll() {
    renderHeader();
    renderGrid();
    renderPager();
  }

  function renderHeader() {
    $('#catTitle').textContent = state.typeName || '全部';
    const parts = [`共 ${fmtNum(state.total)} 部`];
    if (state.pagecount > 1) parts.push(`第 ${state.page}/${state.pagecount} 页`);
    if (state.year) parts.push(state.year);
    const byName = (ORDERS.find((o) => o.v === state.by) || {}).n;
    if (state.by) parts.push(byName + '排序');
    $('#catMeta').textContent = parts.join(' · ');
  }

  function cardHtml(item, i) {
    const srcId = item.source;
    let visual;
    if (item.pic) {
      visual = `<img src="/api/img?u=${encodeURIComponent(item.pic)}&ref=${encodeURIComponent(item.source ? '' : '')}" alt="" loading="lazy"
        onerror="this.parentNode.innerHTML='<div class=&quot;noimg&quot;>${esc(String(item.name || '影').charAt(0))}</div>'">`;
    } else {
      let h = 0;
      const nm = String(item.name || '影');
      for (let k = 0; k < nm.length; k += 1) h = (h * 31 + nm.charCodeAt(k)) % 360;
      visual = `<div class="noimg" style="background:linear-gradient(135deg,hsl(${h},45%,28%),hsl(${(h + 60) % 360},50%,18%));font-size:34px;font-weight:700;color:rgba(255,255,255,.85)">${esc(nm.charAt(0))}</div>`;
    }
    return `<div class="card" data-i="${i}">
      <div class="poster">${visual}</div>
      <div class="info">
        <div class="name">${esc(item.name)}</div>
        <div class="remarks">${esc(item.remarks || '')}</div>
      </div>
    </div>`;
  }

  function renderGrid() {
    const grid = $('#catGrid');
    if (!state.items.length) {
      grid.innerHTML = '<div class="cat-empty">这个分类下没有内容，换一个试试</div>';
      return;
    }
    grid.innerHTML = state.items.map((it, i) => cardHtml(it, i)).join('');
    $$('#catGrid .card').forEach((c) => c.addEventListener('click', () => {
      const item = state.items[Number(c.dataset.i)];
      if (item && window.__mhOpenItem) window.__mhOpenItem(item);
    }));
  }

  function renderPager() {
    const box = $('#catPager');
    if (state.pagecount <= 1) { box.innerHTML = ''; return; }
    const cur = state.page;
    const nums = [];
    const push = (p) => { if (p >= 1 && p <= state.pagecount && !nums.includes(p)) nums.push(p); };
    push(1); push(2);
    for (let p = cur - 2; p <= cur + 2; p += 1) push(p);
    push(state.pagecount - 1); push(state.pagecount);
    nums.sort((a, b) => a - b);
    let html = `<button class="cat-pg" data-p="${cur - 1}" ${cur <= 1 ? 'disabled' : ''}>‹ 上一页</button>`;
    let last = 0;
    nums.forEach((p) => {
      if (p - last > 1) html += '<span class="cat-pg-gap">…</span>';
      html += `<button class="cat-pg ${p === cur ? 'active' : ''}" data-p="${p}">${p}</button>`;
      last = p;
    });
    html += `<button class="cat-pg" data-p="${cur + 1}" ${cur >= state.pagecount ? 'disabled' : ''}>下一页 ›</button>`;
    box.innerHTML = html;
    $$('#catPager .cat-pg').forEach((b) => b.addEventListener('click', () => {
      const p = Number(b.dataset.p);
      if (!p || p < 1 || p > state.pagecount || p === state.page) return;
      state.page = p;
      loadBrowse();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }));
  }

  // 供 nav 调用
  window.__mhCat = showCat;
})();
