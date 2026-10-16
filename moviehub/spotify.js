'use strict';
/**
 * Spotify 模块（spotify.js）
 *
 * 三条播放通道，按账号等级自动降级：
 *   ① librespot 本地设备（Premium）— 服务端拉起 librespot 进程作为 Spotify Connect 设备，
 *      通过 Web API device_id 指定播放，音频走本机声卡
 *   ② Web Playback SDK（Premium）— 浏览器内播放，纯 JS，无需任何二进制
 *   ③ 30 秒试听（免费账号）— preview_url 直链
 *
 * 元数据（搜索/歌单/专辑）走 Spotify Web API，所有账号可用。
 * 登录走 Authorization Code + PKCE，无需 client_secret，token 落盘在本机。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

let H = null;
function init(helpers) { H = helpers; }

const ROOT = __dirname;
const TOKEN_FILE = path.join(ROOT, '.cache', 'spotify-token.json');
const CONF_FILE = path.join(ROOT, 'spotify.json');
const LR_BIN_CANDIDATES = [
  path.join(ROOT, 'bin', 'librespot.exe'),
  path.join(ROOT, 'bin', 'librespot'),
];

const API = 'https://api.spotify.com/v1';
const AUTH = 'https://accounts.spotify.com';
const DEVICE_NAME = '观影中心';

const SCOPES = [
  'user-read-private', 'user-read-email', 'user-read-playback-state',
  'user-modify-playback-state', 'user-read-currently-playing', 'playlist-read-private',
].join(' ');

/* ---------------- 配置与令牌 ---------------- */

function loadConf() {
  try {
    return JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
  } catch (e) {
    return { clientId: '', redirectPort: 7123, librespotPath: '', autoStartLibrespot: true };
  }
}

function loadToken() {
  try {
    const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (t.access_token && t.expires_at > Date.now() + 60000) return t;
    return t;
  } catch (e) { return null; }
}

function saveToken(t) {
  if (!fs.existsSync(path.dirname(TOKEN_FILE))) fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));
}

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

/** 待处理的登录会话（state -> verifier + port） */
const pending = new Map();

/* ---------------- Web API 封装 ---------------- */

async function api(pathname, method, body, token) {
  const t = token || (loadToken() || {}).access_token;
  if (!t) { const e = new Error('未登录 Spotify'); e.code = 'AUTH_REQUIRED'; throw e; }
  const r = await H.request(API + pathname, '', {
    timeout: 15000, maxSize: 8 * 1024 * 1024,
    method: method || 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + t }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return {};
  let j;
  try { j = JSON.parse(r.body.toString('utf8').replace(/^\uFEFF/, '')); } catch (e) { j = {}; }
  if (r.status === 401 && j.error && j.error.message === 'The access token expired') {
    const refreshed = await refreshToken();
    if (refreshed) return api(pathname, method, body, refreshed.access_token);
  }
  if (r.status >= 400) { const e = new Error('Spotify API ' + r.status + '：' + (j.error && j.error.message || r.body.toString('utf8').slice(0, 120))); e.status = r.status; throw e; }
  return j;
}

async function refreshToken() {
  const cur = loadToken();
  if (!cur || !cur.refresh_token) return null;
  const conf = loadConf();
  const r = await H.request(AUTH + '/api/token', '', {
    timeout: 15000, maxSize: 1024 * 1024, method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: cur.refresh_token, client_id: conf.clientId,
    }).toString(),
  });
  if (r.status !== 200) return null;
  const j = JSON.parse(r.body.toString('utf8'));
  const merged = Object.assign({}, cur, j, { expires_at: Date.now() + (j.expires_in || 3600) * 1000 });
  saveToken(merged);
  return merged;
}

/* ---------------- librespot 本地设备 ---------------- */

let lrProc = null;
let lrLog = [];

function findLibrespot() {
  const conf = loadConf();
  if (conf.librespotPath && fs.existsSync(conf.librespotPath)) return conf.librespotPath;
  for (const p of LR_BIN_CANDIDATES) if (fs.existsSync(p)) return p;
  return '';
}

function lrStatus() {
  return {
    running: !!lrProc,
    pid: lrProc ? lrProc.pid : 0,
    binary: findLibrespot() || '',
    log: lrLog.slice(-6).join(' | ').slice(0, 400),
  };
}

function startLibrespot() {
  const bin = findLibrespot();
  if (!bin) return { ok: false, error: '未找到 librespot 可执行文件（放到 moviehub/bin/librespot.exe）' };
  if (lrProc) return { ok: true, pid: lrProc.pid };
  const conf = loadConf();
  lrLog = [];
  const cacheDir = path.join(ROOT, '.cache', 'librespot');
  try {
    lrProc = spawn(bin, [
      '-n', DEVICE_NAME, '-b', '320',
      '-c', cacheDir,
      '--enable-volume-normalisation',
      '--initial-volume', '70',
      '--device-type', 'speaker',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { ok: false, error: '启动失败：' + e.message };
  }
  const push = (s) => { lrLog.push(String(s).trim().slice(0, 160)); if (lrLog.length > 20) lrLog.shift(); };
  lrProc.stdout.on('data', (d) => push(d.toString()));
  lrProc.stderr.on('data', (d) => push(d.toString()));
  lrProc.on('exit', (c) => { lrLog.push('退出 code=' + c); lrProc = null; });
  return { ok: true, pid: lrProc.pid };
}

function stopLibrespot() {
  if (!lrProc) return { ok: true };
  try { lrProc.kill(); } catch (e) { /* 已退出 */ }
  lrProc = null;
  return { ok: true };
}

/** 在账号设备列表里找到我们的 librespot 设备 */
async function findDevice() {
  const j = await api('/me/player/devices');
  const d = (j.devices || []).find((x) => x.name === DEVICE_NAME) || (j.devices || [])[0];
  return d || null;
}

/** 等 librespot 注册为 Connect 设备（最多 ~25 秒） */
async function waitDevice(timeoutMs) {
  const t0 = Date.now();
  const limit = timeoutMs || 25000;
  let last = null;
  while (Date.now() - t0 < limit) {
    try { const d = await findDevice(); if (d) return d; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (last) throw last;
  return null;
}

/* ---------------- 对外接口 ---------------- */

async function handleStatus(q, res) {
  const conf = loadConf();
  const tok = loadToken();
  let me = null;
  if (tok && tok.access_token) {
    try { me = await api('/me'); } catch (e) { me = { error: e.message }; }
  }
  H.sendJson(res, 200, {
    configured: !!conf.clientId,
    loggedIn: !!(tok && tok.access_token),
    user: me && me.id ? { id: me.id, name: me.display_name, product: me.product, avatar: (me.images && me.images[0] && me.images[0].url) || '' } : null,
    premium: !!(me && me.product === 'premium'),
    librespot: lrStatus(),
    channels: {
      librespot: { label: 'librespot 本地声卡', need: 'Premium + librespot 可执行文件' },
      sdk: { label: '浏览器内播放 (Web Playback SDK)', need: 'Premium + Spotify 登录' },
      preview: { label: '30 秒试听', need: '任意账号' },
    },
  });
}

/** 第一步：生成授权链接（PKCE） */
async function handleLogin(q, res) {
  const conf = loadConf();
  if (!conf.clientId) return H.sendJson(res, 400, { error: '请先在 spotify.json 填入 clientId（到 developer.spotify.com 注册应用）' });
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const port = conf.redirectPort || 7123;
  pending.set(state, { verifier, port, t: Date.now() });
  const redirectUri = 'http://127.0.0.1:' + port + '/spotify/callback';
  const url = AUTH + '/authorize?' + new URLSearchParams({
    client_id: conf.clientId, response_type: 'code', redirect_uri: redirectUri,
    code_challenge_method: 'S256', code_challenge: challenge, state, scope: SCOPES,
  }).toString();
  startCallbackServer(port);
  H.sendJson(res, 200, { authUrl: url, redirectUri, state });
}

/** 本地回调服务器：Spotify 授权后自动跳转到这里，免去手动复制地址 */
let cbServer = null;
function startCallbackServer(port) {
  if (cbServer && cbServer.listening) return;
  const http = require('http');
  const page = (ok, msg) => `<!DOCTYPE html><meta charset="utf-8"><title>观影中心</title>
<body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:52px">${ok ? '✅' : '❌'}</div>
<h2 style="font-weight:500">${msg}</h2><p style="color:#888">可以关闭这个页面，回到观影中心</p></div></body>`;
  cbServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/spotify/callback') { res.writeHead(404); res.end('not found'); return; }
    const code = u.searchParams.get('code');
    const st = u.searchParams.get('state');
    const err = u.searchParams.get('error');
    if (err || !code || !pending.has(st)) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(false, '授权失败：' + (err || 'state 无效')));
      return;
    }
    const sess = pending.get(st);
    pending.delete(st);
    try {
      const r = await H.request(AUTH + '/api/token', '', {
        timeout: 15000, maxSize: 1024 * 1024, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code,
          redirect_uri: 'http://127.0.0.1:' + port + '/spotify/callback',
          client_id: loadConf().clientId, code_verifier: sess.verifier,
        }).toString(),
      });
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      const j = JSON.parse(r.body.toString('utf8'));
      saveToken(Object.assign({}, j, {
        expires_at: Date.now() + (j.expires_in || 3600) * 1000, scope: SCOPES,
      }));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(true, 'Spotify 登录成功'));
      setTimeout(() => { try { cbServer.close(); cbServer = null; } catch (e) { /* 忽略 */ } }, 1500);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(false, '换取令牌失败：' + e.message));
    }
  });
  cbServer.on('error', () => { cbServer = null; });
  cbServer.listen(port, '127.0.0.1');
}

/** 第二步：用户在浏览器完成授权后，把地址栏 URL 贴回来换 token */
async function handleCallback(q, res) {
  const conf = loadConf();
  const full = (q.url || '').trim();
  if (!full) return H.sendJson(res, 400, { error: '缺少授权后地址 url' });
  let parsed;
  try { parsed = new URL(full); } catch (e) { return H.sendJson(res, 400, { error: '地址无法解析' }); }
  const code = parsed.searchParams.get('code');
  const state = parsed.searchParams.get('state');
  const err = parsed.searchParams.get('error');
  if (err) return H.sendJson(res, 400, { error: 'Spotify 返回错误：' + err });
  const sess = pending.get(state);
  if (!code || !sess) return H.sendJson(res, 400, { error: 'code/state 无效或已过期，请重新登录' });
  pending.delete(state);
  const port = sess.port;
  const r = await H.request(AUTH + '/api/token', '', {
    timeout: 15000, maxSize: 1024 * 1024, method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:' + port + '/spotify/callback',
      client_id: conf.clientId, code_verifier: sess.verifier,
    }).toString(),
  });
  if (r.status !== 200) return H.sendJson(res, 400, { error: '换取 token 失败 HTTP ' + r.status + '：' + r.body.toString('utf8').slice(0, 200) });
  const j = JSON.parse(r.body.toString('utf8'));
  const tok = Object.assign({}, j, { expires_at: Date.now() + (j.expires_in || 3600) * 1000, scope: SCOPES });
  saveToken(tok);
  pending.forEach((v, k) => { if (Date.now() - v.t > 600000) pending.delete(k); });
  H.sendJson(res, 200, { ok: true, expiresIn: j.expires_in, scope: j.scope });
}

function handleLogout(q, res) {
  try { fs.unlinkSync(TOKEN_FILE); } catch (e) { /* 无 */ }
  stopLibrespot();
  H.sendJson(res, 200, { ok: true });
}

async function handleSearch(q, res) {
  const kw = (q.kw || '').trim();
  if (!kw) return H.sendJson(res, 400, { error: '缺少关键词 kw' });
  const limit = Math.min(20, Math.max(1, parseInt(q.limit || '20', 10) || 20));
  const j = await api('/search?q=' + enc(kw) + '&type=track&limit=' + limit + '&market=from_token');
  const items = (j.tracks && j.tracks.items || []).map((t) => ({
    id: t.id,
    uri: t.uri,
    name: t.name,
    singer: (t.artists || []).map((a) => a.name).join(' / '),
    album: (t.album && t.album.name) || '',
    duration: Math.round((t.duration_ms || 0) / 1000),
    pic: (t.album && t.album.images && t.album.images[1] && t.album.images[1].url) ||
      (t.album && t.album.images && t.album.images[0] && t.album.images[0].url) || '',
    preview: t.preview_url || '',
    explicit: !!t.explicit,
  }));
  H.sendJson(res, 200, { kw, total: (j.tracks && j.tracks.total) || items.length, items });
}

async function handlePlaylists(q, res) {
  const j = await api('/me/playlists?limit=50');
  const items = (j.items || []).map((p) => ({
    id: p.id, uri: p.uri, name: p.name, count: (p.tracks && p.tracks.total) || 0,
    pic: (p.images && p.images[0] && p.images[0].url) || '', owner: (p.owner && p.owner.display_name) || '',
  }));
  H.sendJson(res, 200, { items });
}

async function handlePlaylistTracks(q, res) {
  const id = q.id;
  if (!id) return H.sendJson(res, 400, { error: '缺少歌单 id' });
  const j = await api('/playlists/' + enc(id) + '/tracks?limit=50');
  const items = (j.items || []).map((it) => it.track).filter(Boolean).map((t) => ({
    id: t.id, uri: t.uri, name: t.name,
    singer: (t.artists || []).map((a) => a.name).join(' / '),
    album: (t.album && t.album.name) || '',
    duration: Math.round((t.duration_ms || 0) / 1000),
    pic: (t.album && t.album.images && t.album.images[1] && t.album.images[1].url) || '',
    preview: t.preview_url || '',
  }));
  H.sendJson(res, 200, { id, items });
}

/** 启动 librespot 并等它注册为设备 */
async function handleStart(q, res) {
  const st = startLibrespot();
  if (!st.ok) return H.sendJson(res, 400, st);
  try {
    const d = await waitDevice(25000);
    if (!d) return H.sendJson(res, 200, { ok: true, device: null, warn: 'librespot 已启动但未出现在设备列表（可能需 Premium 账号）' });
    H.sendJson(res, 200, { ok: true, device: { id: d.id, name: d.name, type: d.type, volume: d.volume_percent } });
  } catch (e) {
    H.sendJson(res, 200, { ok: true, device: null, warn: e.message });
  }
}

async function handleStop(q, res) {
  stopLibrespot();
  H.sendJson(res, 200, { ok: true, librespot: lrStatus() });
}

/** 播放：优先 librespot 设备，否则转交浏览器 SDK（由前端 token 直连） */
async function handlePlay(q, res) {
  let uris;
  try { uris = JSON.parse(q.uris || '[]'); } catch (e) { uris = []; }
  if (!Array.isArray(uris) || !uris.length) return H.sendJson(res, 400, { error: '缺少 uris（spotify:track:xxx 数组）' });
  const channel = q.channel || 'librespot';
  if (channel === 'librespot') {
    if (!lrProc) { const st = startLibrespot(); if (!st.ok) return H.sendJson(res, 400, st); }
    let device = null;
    try { device = await waitDevice(20000); } catch (e) { /* 继续用默认设备 */ }
    const body = uris.length === 1 && uris[0].indexOf(':track:') > 0 ? { uris } : { context_uri: uris[0], offset: { position: 0 } };
    await api('/me/player/play' + (device ? '?device_id=' + enc(device.id) : ''), 'PUT', body);
    return H.sendJson(res, 200, { ok: true, channel: 'librespot', device: device ? device.name : DEVICE_NAME });
  }
  // SDK 通道：由浏览器用同一 token 直接控制，服务端只回传必要信息
  const tok = loadToken();
  H.sendJson(res, 200, { ok: true, channel: 'sdk', accessToken: tok ? tok.access_token : '', uris });
}

async function handlePlayer(q, res) {
  const method = (q._method || 'GET').toUpperCase();
  if (method === 'PUT' || method === 'POST') {
    const action = q.action;
    const device = q.device_id ? '?device_id=' + enc(q.device_id) : '';
    if (action === 'play') await api('/me/player/play' + device, 'PUT', q.uris ? { uris: q.uris } : undefined);
    else if (action === 'pause') await api('/me/player/pause' + device, 'PUT');
    else if (action === 'next') await api('/me/player/next' + device, 'POST');
    else if (action === 'prev') await api('/me/player/previous' + device, 'POST');
    else if (action === 'volume') await api('/me/player/volume?volume_percent=' + (parseInt(q.v, 10) || 50) + device.replace('?', '&'), 'PUT');
    else return H.sendJson(res, 400, { error: '未知操作 ' + action });
    return H.sendJson(res, 200, { ok: true });
  }
  try {
    const j = await api('/me/player');
    H.sendJson(res, 200, {
      playing: !!(j && j.is_playing), device: j && j.device ? j.device.name : '',
      progress: j ? j.progress_ms : 0,
      track: j && j.item ? {
        name: j.item.name, uri: j.item.uri,
        singer: (j.item.artists || []).map((a) => a.name).join(' / '),
        album: (j.item.album && j.item.album.name) || '',
        duration: Math.round((j.item.duration_ms || 0) / 1000),
        pic: (j.item.album && j.item.album.images && j.item.album.images[1] && j.item.album.images[1].url) || '',
      } : null,
    });
  } catch (e) {
    H.sendJson(res, 200, { playing: false, device: '', track: null, error: e.message });
  }
}

const enc = encodeURIComponent;

module.exports = {
  init, handleStatus, handleLogin, handleCallback, handleLogout,
  handleSearch, handlePlaylists, handlePlaylistTracks,
  handleStart, handleStop, handlePlay, handlePlayer,
};
