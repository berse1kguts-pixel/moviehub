/* ═══════════════ 音乐模块 前端逻辑 ═══════════════ */
(() => {
  'use strict';

  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  const LS_PLAYLIST = 'mh_playlist';
  const LS_MODE = 'mh_playmode';

  const state = {
    tab: 'local',           // local | spotify | playlist
    platforms: [],          // [{key,name,search,url,note}]
    platform: 'wy',         // 当前搜索平台
    results: [],            // 当前平台搜索结果
    resultPlatform: '',
    playlist: [],           // 播放列表 [{name,singer,platform,musicInfo,src,duration,pic}]
    playIdx: -1,
    mode: localStorage.getItem(LS_MODE) || 'list',  // list | one | shuffle
    audio: new Audio(),
    spotify: { configured: false, loggedIn: false, premium: false, user: null, librespot: {}, spResults: [], spPlaylists: [], spTracks: [], channel: 'sdk' },
    spPlayer: null,
    spDeviceId: null,
    spToken: '',
    spPoll: 0,
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function toast(msg, ms) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t.classList.add('hidden'), ms || 3000);
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  async function api(path, opts) {
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok && j.error) throw new Error(j.error);
    return j;
  }

  /* ─────────── 视图切换 ─────────── */

  function showMusic() {
    ['home', 'search', 'detail', 'player', 'music'].forEach((v) => {
      const el = $('#view-' + v);
      if (el) el.classList.toggle('hidden', v !== 'music');
    });
    if (!state.platforms.length) loadPlatforms();
    renderMusic();
  }

  $$('.nav-btn').forEach((b) => {
    b.addEventListener('click', () => {
      $$('.nav-btn').forEach((x) => x.classList.toggle('active', x === b));
      const nav = b.dataset.nav;
      if (nav === 'music') showMusic();
      else if (nav === 'cat' && window.__mhCat) window.__mhCat();
      else window.__mhShow && window.__mhShow(nav);
    });
  });

  /* ─────────── 平台与搜索 ─────────── */

  async function loadPlatforms() {
    try {
      const j = await api('/api/music/sources');
      state.platforms = j.platforms || [];
      if (!state.platforms.some((p) => p.key === state.platform)) {
        const first = state.platforms.find((p) => p.search);
        if (first) state.platform = first.key;
      }
      renderChips();
    } catch (e) { toast('音源信息加载失败：' + e.message); }
  }

  function renderChips() {
    const box = $('#mChips');
    if (!box) return;
    box.innerHTML = state.platforms.map((p) => {
      const badge = [p.search ? '搜' : '', p.url ? '播' : ''].filter(Boolean).join('+');
      const cls = p.key === state.platform ? 'chip active' : 'chip';
      const dis = p.search ? '' : ' disabled';
      return `<button class="${cls}${dis}" data-p="${esc(p.key)}" title="${esc(p.note || '')}">${esc(p.name)}<i>${badge}</i></button>`;
    }).join('');
    $$('#mChips .chip').forEach((c) => c.addEventListener('click', () => {
      const p = state.platforms.find((x) => x.key === c.dataset.p);
      if (!p || !p.search) { toast(p ? p.note : '该平台不可搜索'); return; }
      state.platform = c.dataset.p;
      renderChips();
      doSearch();
    }));
  }

  async function doSearch() {
    const kw = ($('#mSearchInput').value || '').trim();
    if (!kw) return;
    const box = $('#mResults');
    box.innerHTML = '<div class="m-loading">搜索中…</div>';
    try {
      const j = await api('/api/music/search?kw=' + encodeURIComponent(kw) + '&platform=' + state.platform);
      state.resultPlatform = state.platform;
      state.results = (j.results[0] && j.results[0].items) || [];
      renderResults();
    } catch (e) {
      box.innerHTML = `<div class="m-empty">搜索失败：${esc(e.message)}</div>`;
    }
  }

  function renderResults() {
    const box = $('#mResults');
    if (!state.results.length) {
      box.innerHTML = '<div class="m-empty">没有结果，换个关键词试试</div>';
      return;
    }
    const pName = (state.platforms.find((p) => p.key === state.resultPlatform) || {}).name || '';
    box.innerHTML = `<div class="m-list">${state.results.map((r, i) => `
      <div class="m-row" data-i="${i}">
        <span class="m-idx">${String(i + 1).padStart(2, '0')}</span>
        <button class="m-playbtn" data-i="${i}" title="播放">▶</button>
        <div class="m-meta">
          <div class="m-title">${esc(r.name)}</div>
          <div class="m-sub">${esc(r.singer)}${r.album ? ' · ' + esc(r.album) : ''}${r.duration ? ' · ' + fmtTime(r.duration) : ''}</div>
        </div>
        <button class="m-add" data-i="${i}" title="加入播放列表">＋</button>
      </div>`).join('')}</div>
      <div class="m-tip">来源：${esc(pName)}</div>`;
    $$('#mResults .m-playbtn').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      playAt(Number(b.dataset.i));
    }));
    $$('#mResults .m-add').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      addToPlaylist(Number(b.dataset.i));
    }));
    $$('#mResults .m-row').forEach((row) => row.addEventListener('dblclick', () => playAt(Number(row.dataset.i))));
  }

  /* ─────────── 播放 ─────────── */

  function addToPlaylist(i) {
    const r = state.results[i];
    if (!r) return;
    state.playlist.push({
      name: r.name, singer: r.singer, platform: r.platform,
      musicInfo: r.musicInfo, duration: r.duration, pic: r.pic,
    });
    savePlaylist();
    renderPlaylist();
    toast('已加入播放列表');
  }

  function savePlaylist() {
    try { localStorage.setItem(LS_PLAYLIST, JSON.stringify(state.playlist)); } catch (e) { /* 忽略 */ }
  }

  function loadPlaylist() {
    try { state.playlist = JSON.parse(localStorage.getItem(LS_PLAYLIST)) || []; } catch (e) { state.playlist = []; }
  }

  async function playAt(i) {
    const item = state.tab === 'playlist' ? state.playlist[i] : null;
    const target = item || state.results[i];
    if (!target) return;
    const platform = target.platform;
    const info = target.musicInfo;
    $('#musicbar').classList.remove('hidden');
    $('#mbName').textContent = target.name;
    $('#mbSinger').textContent = target.singer || '';
    $('#mbSrc').textContent = '解析中…';
    $('#mbToggle').textContent = '…';
    try {
      const j = await api('/api/music/url?platform=' + platform + '&info=' + encodeURIComponent(JSON.stringify(info)));
      if (!j.url) throw new Error('未返回播放地址');
      state.audio.src = j.url;
      state.playIdx = i;
      state.curVia = j.via;
      state.curQuality = j.quality;
      $('#mbSrc').textContent = (j.quality || '') + (j.via ? ' · ' + j.via : '');
      $('#mbToggle').textContent = '⏸';
      await state.audio.play().catch((e) => { throw e; });
      fetchLyric(target);
      highlightPlaying();
    } catch (e) {
      // 自动换源：搜索结果里接着试下一首（与影视模块的自动换线路一致）
      const isList = state.tab === 'playlist';
      const pool = isList ? state.playlist : state.results;
      const canFallback = pool && pool.length > 1 && state.playIdx !== -1 || (!isList && state.results.length > 1);
      if (canFallback) {
        const tried = playAt._tried || 0;
        if (tried < 5) {
          playAt._tried = tried + 1;
          const next = isList ? (i + 1) % pool.length : Math.min(i + 1, pool.length - 1);
          $('#mbSrc').textContent = '失败，试下一首…';
          toast('「' + target.name + '」不可播，自动切换');
          setTimeout(() => playAt(next), 350);
          return;
        }
      }
      playAt._tried = 0;
      $('#mbSrc').textContent = '失败';
      $('#mbToggle').textContent = '▶';
      toast('播放失败：' + e.message);
    }
  }

  async function fetchLyric(target) {
    const box = $('#mLyric');
    if (!box) return;
    box.innerHTML = '<div class="m-lyric-loading">歌词加载中…</div>';
    try {
      const j = await api('/api/music/lyric?platform=' + target.platform +
        '&info=' + encodeURIComponent(JSON.stringify(target.musicInfo)));
      const raw = j.lyric || '';
      if (!raw) { box.innerHTML = '<div class="m-lyric-none">暂无歌词</div>'; return; }
      state.lyricLines = parseLrc(raw);
      state.lyricBox = box;
      renderLyric(0);
    } catch (e) {
      box.innerHTML = '<div class="m-lyric-none">歌词加载失败</div>';
    }
  }

  function parseLrc(raw) {
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
      if (!m) continue;
      out.push({ t: Number(m[1]) * 60 + Number(m[2]), text: m[3].replace(/<\d+,\d+,\d+>/g, '').trim() });
    }
    return out;
  }

  function renderLyric(cur) {
    if (!state.lyricBox || !state.lyricLines) return;
    if (!state.lyricLines.length) { state.lyricBox.innerHTML = '<div class="m-lyric-none">暂无歌词</div>'; return; }
    let idx = 0;
    for (let i = 0; i < state.lyricLines.length; i += 1) if (state.lyricLines[i].t <= cur) idx = i;
    state.lyricBox.innerHTML = state.lyricLines.map((l, i) =>
      `<div class="ly${i === idx ? ' cur' : ''}">${esc(l.text) || '♪'}</div>`).join('');
    const el = state.lyricBox.querySelector('.ly.cur');
    if (el) el.scrollIntoView({ block: 'center' });
  }

  function highlightPlaying() {
    $$('#mResults .m-row').forEach((r) => r.classList.remove('playing'));
    $$('#mPlaylist .m-row').forEach((r) => r.classList.remove('playing'));
    const sel = state.tab === 'playlist' ? '#mPlaylist .m-row' : '#mResults .m-row';
    const rows = $$(sel);
    if (rows[state.playIdx]) {
      rows[state.playIdx].classList.add('playing');
      rows[state.playIdx].scrollIntoView({ block: 'nearest' });
    }
  }

  /* ─────────── 播放条 ─────────── */

  function bindBar() {
    const a = state.audio;
    $('#mbToggle').addEventListener('click', () => {
      if (state.spPlayer && state.spotify.channel !== 'local') { spToggle(); return; }
      if (a.paused) { a.play().catch(() => {}); $('#mbToggle').textContent = '⏸'; }
      else { a.pause(); $('#mbToggle').textContent = '▶'; }
    });
    $('#mbNext').addEventListener('click', () => next());
    $('#mbPrev').addEventListener('click', () => prev());
    $('#mbMode').addEventListener('click', () => {
      const order = ['list', 'one', 'shuffle'];
      state.mode = order[(order.indexOf(state.mode) + 1) % order.length];
      localStorage.setItem(LS_MODE, state.mode);
      $('#mbMode').textContent = { list: '🔁', one: '🔂', shuffle: '🔀' }[state.mode];
      toast({ list: '列表循环', one: '单曲循环', shuffle: '随机播放' }[state.mode]);
    });
    $('#mbMode').textContent = { list: '🔁', one: '🔂', shuffle: '🔀' }[state.mode];

    a.addEventListener('timeupdate', () => {
      $('#mbTime').textContent = fmtTime(a.currentTime) + ' / ' + fmtTime(a.duration || 0);
      if (a.duration) $('#mbSeek').value = String(Math.round((a.currentTime / a.duration) * 1000));
      if (state.lyricLines) renderLyric(a.currentTime);
    });
    a.addEventListener('ended', () => next(true));
    a.addEventListener('error', () => {
      $('#mbSrc').textContent = '加载失败';
      $('#mbToggle').textContent = '▶';
    });
    $('#mbSeek').addEventListener('input', () => {
      if (a.duration) a.currentTime = (Number($('#mbSeek').value) / 1000) * a.duration;
    });
  }

  function next(auto) {
    const list = state.playlist;
    if (!list.length) { toast('播放列表是空的'); return; }
    if (state.mode === 'one' && auto) { state.audio.currentTime = 0; state.audio.play().catch(() => {}); return; }
    let i;
    if (state.mode === 'shuffle') i = Math.floor(Math.random() * list.length);
    else i = (state.playIdx + 1) % list.length;
    state.tab = 'playlist';
    playAt(i);
  }

  function prev() {
    const list = state.playlist;
    if (!list.length) { toast('播放列表是空的'); return; }
    const i = (state.playIdx - 1 + list.length) % list.length;
    state.tab = 'playlist';
    playAt(i);
  }

  /* ─────────── Spotify ─────────── */

  function loadSdk() {
    return new Promise((resolve, reject) => {
      if (window.Spotify) return resolve();
      const s = document.createElement('script');
      s.src = 'https://sdk.scdn.co/spotify-player.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Spotify SDK 加载失败（需要联网）'));
      document.head.appendChild(s);
    });
  }

  async function spInitPlayer() {
    try {
      await loadSdk();
    } catch (e) { toast(e.message); return; }
    state.spPlayer = new window.Spotify.Player({
      name: '观影中心',
      getOAuthToken: (cb) => cb(state.spToken),
      volume: 0.7,
    });
    state.spPlayer.addListener('ready', ({ device_id }) => {
      state.spDeviceId = device_id;
      $('#spDevState').textContent = '浏览器播放器就绪（' + device_id.slice(0, 8) + '）';
    });
    state.spPlayer.addListener('not_ready', () => { $('#spDevState').textContent = '浏览器播放器离线'; });
    state.spPlayer.addListener('player_state_changed', (st) => {
      if (!st) return;
      const t = st.track_window.current_track;
      $('#mbName').textContent = t.name;
      $('#mbSinger').textContent = t.artists.map((a) => a.name).join(' / ');
      $('#mbToggle').textContent = st.paused ? '▶' : '⏸';
      $('#mbTime').textContent = fmtTime(st.position / 1000) + ' / ' + fmtTime(st.duration / 1000);
      $('#mbSrc').textContent = 'Spotify';
    });
    const ok = await state.spPlayer.connect();
    if (!ok) toast('Spotify 播放器连接失败');
  }

  async function spLogin() {
    try {
      const j = await api('/api/spotify/login');
      if (window.desktop && window.desktop.isDesktop) {
        // Electron：用系统浏览器打开，授权后自动回调
        const { shell } = window.require ? window.require('electron') : {};
        if (shell) { shell.openExternal(j.authUrl); return; }
      }
      window.open(j.authUrl, '_blank', 'width=520,height=700');
    } catch (e) { toast('登录失败：' + e.message); }
  }

  async function spStatus() {
    try {
      const j = await api('/api/spotify/status');
      const s = state.spotify;
      s.configured = j.configured;
      s.loggedIn = j.loggedIn;
      s.premium = j.premium;
      s.user = j.user;
      s.librespot = j.librespot || {};
      renderSpotify();
      if (s.loggedIn && !s.spToken) {
        const t = await api('/api/spotify/play', { method: 'GET' }).catch(() => null);
        void t;
      }
    } catch (e) { /* 忽略 */ }
  }

  async function spSearch() {
    const kw = ($('#spSearchInput').value || '').trim();
    if (!kw) return;
    $('#spResults').innerHTML = '<div class="m-loading">搜索 Spotify…</div>';
    try {
      const j = await api('/api/spotify/search?kw=' + encodeURIComponent(kw));
      state.spotify.spResults = j.items || [];
      renderSpotifyResults();
    } catch (e) {
      $('#spResults').innerHTML = `<div class="m-empty">${esc(e.message)}</div>`;
    }
  }

  function renderSpotifyResults() {
    const box = $('#spResults');
    if (!state.spotify.spResults.length) {
      box.innerHTML = '<div class="m-empty">没有结果</div>';
      return;
    }
    box.innerHTML = `<div class="m-list">${state.spotify.spResults.map((r, i) => `
      <div class="m-row" data-i="${i}">
        <span class="m-idx">${String(i + 1).padStart(2, '0')}</span>
        <button class="m-playbtn" data-i="${i}" title="播放">▶</button>
        <div class="m-meta">
          <div class="m-title">${esc(r.name)}${r.explicit ? ' <b class="e">E</b>' : ''}</div>
          <div class="m-sub">${esc(r.singer)}${r.album ? ' · ' + esc(r.album) : ''} · ${fmtTime(r.duration)}</div>
        </div>
        <button class="m-add" data-i="${i}" title="收藏到本地列表">＋</button>
      </div>`).join('')}</div>`;
    $$('#spResults .m-playbtn').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      spPlay(Number(b.dataset.i));
    }));
    $$('#spResults .m-add').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = state.spotify.spResults[Number(b.dataset.i)];
      if (r) { state.playlist.push({ name: r.name, singer: r.singer, platform: 'spotify', spotifyUri: r.uri, duration: r.duration, pic: r.pic }); savePlaylist(); renderPlaylist(); toast('已加入播放列表'); }
    }));
  }

  async function spPlay(i) {
    const r = state.spotify.spResults[i];
    if (!r) return;
    $('#musicbar').classList.remove('hidden');
    $('#mbSrc').textContent = '启动 Spotify…';
    try {
      const j = await api('/api/spotify/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: [r.uri], channel: state.spotify.channel }),
      });
      if (j.channel === 'sdk' && j.accessToken) {
        state.spToken = j.accessToken;
        if (!state.spPlayer) await spInitPlayer();
        const r2 = await fetch('/api/spotify/play', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uris: [r.uri], channel: 'sdk' }),
        });
        void r2;
        // 浏览器通道直接用 SDK 播放
        await api('/api/spotify/player?action=play&device_id=' + (state.spDeviceId || ''), { method: 'PUT' }).catch(() => null);
        if (state.spPlayer && state.spDeviceId) {
          await state.spotifyPlayUri ? null : null;
        }
        $('#mbSrc').textContent = 'Spotify';
      } else {
        $('#mbSrc').textContent = 'Spotify · librespot';
      }
      startSpPoll();
    } catch (e) { toast('Spotify 播放失败：' + e.message); }
  }

  function startSpPoll() {
    if (state.spPoll) return;
    state.spPoll = setInterval(async () => {
      try {
        const j = await api('/api/spotify/player');
        if (j.track) {
          $('#mbName').textContent = j.track.name;
          $('#mbSinger').textContent = j.track.singer;
        }
        $('#mbToggle').textContent = j.playing ? '⏸' : '▶';
        $('#mbTime').textContent = fmtTime((j.progress || 0) / 1000) + ' / ' +
          fmtTime(j.track ? j.track.duration : 0);
      } catch (e) { /* 忽略 */ }
    }, 2000);
  }

  async function spToggle() {
    const j = await api('/api/spotify/player').catch(() => null);
    const action = j && j.playing ? 'pause' : 'play';
    await api('/api/spotify/player?action=' + action, { method: 'PUT' }).catch(() => null);
  }

  function renderSpotify() {
    const box = $('#spPanel');
    const s = state.spotify;
    if (!s.configured) {
      box.innerHTML = `<div class="sp-setup">
        <h3>接入 Spotify 需要两步</h3>
        <ol>
          <li>打开 <a href="https://developer.spotify.com/dashboard" target="_blank">developer.spotify.com/dashboard</a> 用 Spotify 账号登录，点 <b>Create app</b></li>
          <li>Redirect URI 填 <code>http://127.0.0.1:7123/spotify/callback</code>，创建后复制 <b>Client ID</b></li>
          <li>粘贴到 <code>moviehub/spotify.json</code> 的 <code>clientId</code> 字段，保存后重启</li>
        </ol>
        <p class="sp-note">说明：Spotify 音频有 DRM，不存在免费直连源。可用的三条路——librespot 本地设备（Premium）、浏览器 Web Playback SDK（Premium）、30 秒试听（任意账号）。</p>
      </div>`;
      return;
    }
    if (!s.loggedIn) {
      box.innerHTML = `<div class="sp-login">
        <p>已配置 Client ID，点击下方按钮用 Spotify 账号授权。</p>
        <button id="spLoginBtn" class="btn-primary">登录 Spotify</button>
        <p class="sp-note">授权页会在浏览器打开，成功后自动回到这里。</p>
      </div>`;
      $('#spLoginBtn').addEventListener('click', spLogin);
      return;
    }
    box.innerHTML = `
      <div class="sp-head">
        <div class="sp-user">
          ${s.user && s.user.avatar ? `<img src="${esc(s.user.avatar)}" alt="">` : '<span class="sp-ava">🎵</span>'}
          <div>
            <b>${esc(s.user ? s.user.name : '')}</b>
            <span class="sp-badge ${s.premium ? 'ok' : 'warn'}">${s.premium ? 'Premium 可完整播放' : '免费账号 · 仅 30 秒试听'}</span>
          </div>
        </div>
        <div class="sp-acts">
          <button id="spLogout" class="btn-ghost">退出登录</button>
        </div>
      </div>
      <div class="sp-channels">
        <span class="sp-ch-label">播放通道</span>
        <button class="chip ${s.channel === 'sdk' ? 'active' : ''}" data-ch="sdk">浏览器内播放</button>
        <button class="chip ${s.channel === 'librespot' ? 'active' : ''}" data-ch="librespot">librespot 声卡</button>
        <span id="spDevState" class="sp-dev">${s.channel === 'sdk' ? 'Premium 可用' : '需 librespot.exe（未检测到）'}</span>
      </div>
      <form class="sp-search" id="spSearchForm">
        <input id="spSearchInput" type="text" placeholder="搜索 Spotify 曲库（歌名 / 歌手）…" autocomplete="off">
        <button type="submit" class="btn-primary">搜索</button>
      </form>
      <div id="spResults" class="m-results"></div>`;
    $('#spLogout').addEventListener('click', async () => {
      await api('/api/spotify/logout', { method: 'POST' }).catch(() => null);
      state.spotify.loggedIn = false;
      spStatus();
    });
    $('#spSearchForm').addEventListener('submit', (e) => { e.preventDefault(); spSearch(); });
    $$('#spPanel .chip[data-ch]').forEach((c) => c.addEventListener('click', () => {
      state.spotify.channel = c.dataset.ch;
      renderSpotify();
      if (c.dataset.ch === 'sdk' && !state.spPlayer) spInitPlayer();
      else if (c.dataset.ch === 'librespot') api('/api/spotify/start', { method: 'POST' }).then(spStatus).catch(() => null);
    }));
    if (s.channel === 'sdk' && !state.spPlayer && s.premium) spInitPlayer();
  }

  /* ─────────── 播放列表 ─────────── */

  function renderPlaylist() {
    const box = $('#mPlaylist');
    if (!state.playlist.length) {
      box.innerHTML = '<div class="m-empty">播放列表为空。在搜索结果或 Spotify 结果里点 ＋ 加入。</div>';
      return;
    }
    box.innerHTML = `<div class="m-list">${state.playlist.map((r, i) => `
      <div class="m-row" data-i="${i}">
        <span class="m-idx">${String(i + 1).padStart(2, '0')}</span>
        <button class="m-playbtn" data-i="${i}" title="播放">▶</button>
        <div class="m-meta">
          <div class="m-title">${esc(r.name)}</div>
          <div class="m-sub">${esc(r.singer)}${r.duration ? ' · ' + fmtTime(r.duration) : ''}</div>
        </div>
        <button class="m-del" data-i="${i}" title="移除">✕</button>
      </div>`).join('')}</div>
      <div class="m-tip">${state.playlist.length} 首 · 双击行也可播放</div>`;
    $$('#mPlaylist .m-playbtn').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      state.tab = 'playlist';
      playAt(Number(b.dataset.i));
    }));
    $$('#mPlaylist .m-del').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      state.playlist.splice(Number(b.dataset.i), 1);
      savePlaylist();
      renderPlaylist();
    }));
    $$('#mPlaylist .m-row').forEach((row) => row.addEventListener('dblclick', () => {
      state.tab = 'playlist';
      playAt(Number(row.dataset.i));
    }));
  }

  /* ─────────── 渲染 ─────────── */

  function renderMusic() {
    const view = $('#view-music');
    if (!view.dataset.built) {
      view.dataset.built = '1';
      view.innerHTML = `
        <div class="m-head">
          <div class="m-tabs">
            <button class="mtab active" data-tab="local">本地音乐</button>
            <button class="mtab" data-tab="spotify">Spotify</button>
            <button class="mtab" data-tab="playlist">播放列表 <i id="mPlCount">0</i></button>
          </div>
        </div>
        <div class="m-body">
          <div class="m-col">
            <form class="m-search" id="mSearchForm">
              <input id="mSearchInput" type="text" placeholder="搜索歌曲 / 歌手…" autocomplete="off">
              <button type="submit" class="btn-primary">搜索</button>
            </form>
            <div class="m-chips" id="mChips"></div>
            <div class="m-results" id="mResults"><div class="m-empty">输入关键词开始搜索</div></div>
          </div>
          <div class="m-col m-col-side">
            <div id="mLyric" class="m-lyric"><div class="m-lyric-none">歌词</div></div>
            <div class="m-side-tabs">
              <button class="mtab2 active" data-t="pl">播放列表</button>
              <button class="mtab2" data-t="sp">Spotify</button>
            </div>
            <div id="mPlaylist" class="m-side-box"></div>
            <div id="spPanel" class="m-side-box hidden"></div>
          </div>
        </div>`;
      $('#mSearchForm').addEventListener('submit', (e) => { e.preventDefault(); state.tab = 'local'; doSearch(); });
      $$('#view-music .mtab').forEach((t) => t.addEventListener('click', () => {
        $$('#view-music .mtab').forEach((x) => x.classList.toggle('active', x === t));
        state.tab = t.dataset.tab;
        $('#mResults').classList.toggle('hidden', state.tab !== 'local');
        $('#mChips').classList.toggle('hidden', state.tab !== 'local');
        $('#mSearchForm').classList.toggle('hidden', state.tab !== 'local');
        $('#spPanel').classList.toggle('hidden', state.tab !== 'spotify');
        if (state.tab === 'playlist') { $('#mResults').innerHTML = ''; }
        if (state.tab === 'spotify') { spStatus(); }
      }));
      $$('#view-music .mtab2').forEach((t) => t.addEventListener('click', () => {
        $$('#view-music .mtab2').forEach((x) => x.classList.toggle('active', x === t));
        const sp = t.dataset.t === 'sp';
        $('#mPlaylist').classList.toggle('hidden', sp);
        $('#spPanel').classList.toggle('hidden', !sp);
        if (sp) spStatus();
      }));
      loadPlaylist();
      renderPlaylist();
      renderChips();
      bindBar();
      $('#mPlCount').textContent = String(state.playlist.length);
    }
    $('#mPlCount').textContent = String(state.playlist.length);
  }

  // 供 app.js 调用：切到音乐视图
  window.__mhMusic = showMusic;
})();
