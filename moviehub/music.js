'use strict';
/**
 * 音乐模块（music.js）—— 洛雪自定义源脚本运行器 + 五平台内置搜索 + 音频流代理
 *
 * 架构与电影模块对称：
 *   洛雪自定义源脚本  ≈  苹果CMS 采集接口（提供“播放地址解析”能力）
 *   五平台内置搜索     ≈  电影搜索聚合（酷狗 / 酷我 / QQ / 网易云 / 咪咕）
 *   /api/mplay 音频代理 ≈ /api/play m3u8 代理（解决防盗链 + 跨域 + UA 校验）
 *
 * 关键事实（来自洛雪官方自定义源文档 + 实测）：
 *   自定义源脚本只负责“根据歌曲信息算出可播 URL”（action = musicUrl），
 *   搜索 / 歌词 / 封面由宿主按各平台公开接口实现。
 * 脚本通过 globalThis.lx 与宿主交互：
 *   const { EVENT_NAMES, request, on, send } = globalThis.lx
 *   send(EVENT_NAMES.inited, {...})          → 声明支持的源
 *   on(EVENT_NAMES.request, ({source, action, info}) => Promise<url>)
 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');

let H = null; // { request, getJson, sendJson }，由 server.js 注入
function init(helpers) { H = helpers; }

const ROOT = __dirname;
const CONF_FILE = path.join(ROOT, 'music-sources.json');
const CACHE_DIR = path.join(ROOT, '.cache', 'lx-sources');
const SCRIPT_TTL = 12 * 3600 * 1000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

const PLATFORMS = {
  wy: { name: '网易云音乐', search: true, url: true, note: '搜索/播放/歌词 全支持' },
  kg: { name: '酷狗音乐', search: true, url: false, note: '播放地址已加签名，仅可搜索' },
  tx: { name: 'QQ音乐', search: true, url: false, note: 'vkey 需登录，仅可搜索' },
  kw: { name: '酷我音乐', search: false, url: true, note: '搜索被 token 风控，已知 rid 可播放' },
  mg: { name: '咪咕音乐', search: false, url: false, note: '接口已改版返回 SPA 页面' },
};
const QUALITY_ORDER = ['flac', '320k', '128k'];
const SEARCHABLE = Object.keys(PLATFORMS).filter((k) => PLATFORMS[k].search);
const enc = encodeURIComponent;

function loadConf() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
    return (raw.scripts || []).filter((s) => s.enabled !== false);
  } catch (e) {
    return [];
  }
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '').trim();
}

function joinSinger(v) {
  if (Array.isArray(v)) return v.map((x) => (x && x.name) || x).filter(Boolean).join(' / ');
  return String(v || '').trim();
}

function guessAudioCT(u, upstream) {
  if (upstream) return upstream;
  const m = /\.([a-z0-9]+)(\?|$)/i.exec(u || '');
  const ext = (m && m[1].toLowerCase()) || '';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'flac') return 'audio/flac';
  if (ext === 'm4a') return 'audio/mp4';
  if (ext === 'ogg' || ext === 'oga') return 'audio/ogg';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'ape') return 'audio/ape';
  return 'audio/mpeg';
}

/* ---------------- 洛雪脚本运行器（vm 沙箱） ---------------- */

const runtimes = new Map(); // id -> { rec, name, version, code, handler, inited, platforms, error }

function parseHeader(code) {
  const pick = (k) => {
    const m = code.match(new RegExp('@' + k + '\\s+([^\\r\\n*]+)'));
    return m ? m[1].trim() : '';
  };
  return { name: pick('name'), version: pick('version'), author: pick('author') };
}

/** 下载脚本：raw 主地址失败则换 jsdelivr；落盘缓存 */
async function fetchScript(rec) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, rec.id + '.js');
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < SCRIPT_TTL) return fs.readFileSync(file, 'utf8');
  } catch (e) { /* 无缓存，继续下载 */ }
  const candidates = [rec.url];
  const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/.exec(rec.url);
  if (m) {
    candidates.push(`https://cdn.jsdelivr.net/gh/${m[1]}@${m[2]}/${m[3]}`);
    candidates.push(`https://fastly.jsdelivr.net/gh/${m[1]}@${m[2]}/${m[3]}`);
  }
  let lastErr;
  for (const u of candidates) {
    try {
      const r = await H.request(u, '', { timeout: 15000, maxSize: 8 * 1024 * 1024 });
      if (r.status === 200 && r.body.length > 500) {
        const code = r.body.toString('utf8');
        fs.writeFileSync(file, code);
        return code;
      }
      lastErr = new Error('HTTP ' + r.status);
    } catch (e) { lastErr = e; }
  }
  // 下载失败但有旧缓存：降级使用
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { /* 无 */ }
  throw lastErr || new Error('脚本下载失败');
}

/** 宿主工具集，对应文档中的 globalThis.lx.utils */
const lxUtils = {
  buffer: {
    from: (data, enc) => Buffer.from(data, enc),
    bufToString: (buf, format) => Buffer.from(buf).toString(format || 'utf8'),
  },
  crypto: {
    md5: (str) => crypto.createHash('md5').update(String(str)).digest('hex'),
    randomBytes: (size) => crypto.randomBytes(size).toString('hex').slice(0, size),
    aesEncrypt: (buffer, mode, key, iv) => {
      const algo = 'aes-128-' + mode;
      const c = crypto.createCipheriv(algo, Buffer.from(key), mode === 'ecb' ? null : Buffer.from(iv));
      return Buffer.concat([c.update(Buffer.from(buffer)), c.final()]);
    },
    rsaEncrypt: (buffer, key) => crypto.publicEncrypt(String(key), Buffer.from(buffer)),
  },
  zlib: {
    inflate: (buffer) => new Promise((res, rej) => zlib.inflate(Buffer.from(buffer), (e, b) => (e ? rej(e) : res(b)))),
    deflate: (buffer) => new Promise((res, rej) => zlib.deflate(Buffer.from(buffer), (e, b) => (e ? rej(e) : res(b)))),
  },
};

/**
 * 宿主侧 HTTP 实现，对应文档中的 lx.request(url, options, callback)。
 * 兼容 callback 与 Promise 两种调用，返回取消函数。
 */
function hostRequest(url, options, callback) {
  let u = url;
  let opts = options || {};
  if (u && typeof u === 'object') { opts = u; u = opts.url; }
  if (typeof opts === 'function') { callback = opts; opts = {}; }
  const method = (opts.method || 'GET').toUpperCase();
  const headers = Object.assign({}, opts.headers || {});
  let body = opts.body;
  if (opts.form && typeof opts.form === 'object') {
    body = new URLSearchParams(opts.form).toString();
    headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
  } else if (body && typeof body === 'object' && !(body instanceof Buffer)) {
    body = JSON.stringify(body);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  const p = (async () => {
    const r = await H.request(u, headers.Referer || headers.referer || '', {
      timeout: opts.timeout || 12000,
      maxSize: 8 * 1024 * 1024,
      method,
      headers,
      body,
    });
    const raw = r.body.toString('utf8');
    const ct = String((r.headers || {})['content-type'] || '');
    // 官方 lx.request 的 resp.body 是解析后的对象，body（第三个回调参数）是原始字符串
    let parsed = raw;
    if (/json/i.test(ct) || /^\s*[[{]/.test(raw)) {
      try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) { parsed = raw; }
    }
    const resp = { statusCode: r.status, headers: r.headers || {}, body: parsed };
    return resp;
  })();
  if (typeof callback === 'function') {
    p.then((resp) => callback(null, resp, resp.body)).catch((e) => callback(e));
    return () => { /* 底层请求不可取消，尽力而为 */ };
  }
  return p;
}

/** 在沙箱中运行脚本，捕获 inited 与 request 处理器 */
function createRuntime(code, info) {
  const state = { inited: null, handler: null };
  const EVENT_NAMES = { inited: 'inited', request: 'request', updateAlert: 'updateAlert' };
  const lx = {
    env: 'desktop',
    version: '1',
    currentScriptInfo: { name: info.name || '', version: info.version || '', rawScript: info.code || '' },
    utils: lxUtils,
    EVENT_NAMES,
    on(evt, fn) { if (evt === EVENT_NAMES.request && typeof fn === 'function') state.handler = fn; },
    send(evt, data) { if (evt === EVENT_NAMES.inited) state.inited = data; },
    request: hostRequest,
  };
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    Buffer,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    navigator: { userAgent: UA },
  };
  const ctx = vm.createContext(sandbox);
  ctx.lx = lx;
  // 常见别名，防止混淆脚本引用报错（vm 内 globalThis 即 ctx 本身，无需设置）
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.global = ctx;
  vm.runInContext(code, ctx, { timeout: 8000 });
  return state;
}

/** 解析 inited 载荷中的 sources 声明：{ 平台 -> { qualitys, actions } } */
function parseDeclared(inited) {
  const out = {};
  const src = (inited && inited.sources) || {};
  for (const k of Object.keys(PLATFORMS)) {
    const s = src[k];
    if (s && (s.type === 'music' || !s.type)) {
      const qs = Array.isArray(s.qualitys) ? s.qualitys.filter((x) => QUALITY_ORDER.includes(x)) : [];
      out[k] = { qualitys: qs.length ? qs : QUALITY_ORDER.slice(), actions: s.actions || ['musicUrl'] };
    }
  }
  if (!Object.keys(out).length) {
    // 兜底：结构未知时递归挖掘平台 key
    const found = new Set();
    const walk = (o, depth) => {
      if (!o || depth > 6) return;
      if (Array.isArray(o)) { o.forEach((x) => walk(x, depth + 1)); return; }
      if (typeof o !== 'object') return;
      for (const k of Object.keys(o)) {
        if (PLATFORMS[k]) found.add(k);
        walk(o[k], depth + 1);
      }
    };
    walk(inited, 0);
    for (const k of found) out[k] = { qualitys: QUALITY_ORDER.slice(), actions: ['musicUrl'] };
  }
  return out;
}

async function ensureRuntime(rec) {
  let rt = runtimes.get(rec.id);
  if (rt && rt.handler) return rt;
  rt = { rec, name: rec.name, version: '', handler: null, inited: null, platforms: [], error: '' };
  runtimes.set(rec.id, rt);
  try {
    const code = await fetchScript(rec);
    const head = parseHeader(code);
    rt.name = head.name || rec.name;
    rt.version = head.version;
    rt.codeLen = code.length;
    const state = createRuntime(code, rt);
    // inited 可能是异步发送，最多等 8 秒
    const t0 = Date.now();
    while (!state.inited && Date.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 200));
    }
    rt.inited = state.inited;
    rt.handler = state.handler;
    if (!rt.handler) throw new Error('脚本未注册 request 处理器');
    const declared = parseDeclared(state.inited);
    rt.platforms = Object.keys(declared);
    rt.declared = declared;
  } catch (e) {
    rt.error = e.message || String(e);
  }
  return rt;
}

async function ensureAll() {
  const recs = loadConf();
  const out = [];
  for (const rec of recs) out.push(await ensureRuntime(rec));
  return out;
}

/** 调用脚本解析播放地址；返回直链 URL 字符串，失败抛错 */
async function callMusicUrl(rt, platform, musicInfo, quality) {
  if (!rt.handler) throw new Error('脚本未就绪：' + (rt.error || rt.name));
  const ret = await new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('解析超时')); } }, 12000);
    Promise.resolve()
      .then(() => rt.handler({ source: platform, action: 'musicUrl', info: { type: quality, musicInfo } }))
      .then((v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } })
      .catch((e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
  });
  const url = typeof ret === 'string' ? ret : (ret && (ret.url || ret.data));
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('未返回有效地址');
  return url;
}

/* ---------------- 五平台内置搜索 ---------------- */

async function searchKg(kw, page) {
  const u = 'https://songsearch.kugou.com/song_search_v2?keyword=' + enc(kw) +
    '&page=' + page + '&pagesize=20&platform=WebFilter&tag=em&filter=2&iscorrection=1&privilege_filter=0&_=' + Date.now();
  const j = await H.getJson(u, {}, 'https://www.kugou.com/');
  const lists = (j.data && j.data.lists) || [];
  return lists.map((s) => ({
    platform: 'kg',
    id: s.FileHash,
    name: stripTags(s.SongName),
    singer: joinSinger(stripTags(s.SingerName)),
    album: stripTags(s.AlbumName),
    duration: parseInt(s.Duration, 10) || 0,
    pic: s.Image || '',
    musicInfo: Object.assign({}, s, {
      id: s.FileHash, hash: s.FileHash, name: stripTags(s.SongName), singer: stripTags(s.SingerName),
      albumName: stripTags(s.AlbumName), albumId: s.AlbumID, duration: parseInt(s.Duration, 10) || 0,
    }),
  }));
}

async function searchTx(kw, page) {
  // client_search_cp 在新版风控下返回空列表，改用 smartbox（免鉴权、字段完整）
  const u = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=' + enc(kw) + '&format=json';
  const r = await H.request(u, 'https://y.qq.com/', { timeout: 12000, maxSize: 4 * 1024 * 1024 });
  const j = JSON.parse(r.body.toString('utf8').replace(/^\uFEFF/, ''));
  const list = (j.data && j.data.song && j.data.song.itemlist) || [];
  return list.map((s) => ({
    platform: 'tx',
    id: s.mid,
    name: stripTags(s.name),
    singer: stripTags(s.singer),
    album: '',
    duration: 0,
    pic: '',
    musicInfo: Object.assign({}, s, {
      id: s.mid, songmid: s.mid, name: stripTags(s.name), singer: stripTags(s.singer),
      albumName: '', duration: 0,
    }),
  }));
}

async function searchKw(kw, page) {
  // 酷我 PC 端搜索需 kw_token cookie（JS 下发），改用移动端 r.s 接口，免鉴权
  const u = 'http://search.kuwo.cn/r.s?all=' + enc(kw) + '&pn=' + ((page - 1) * 20) +
    '&rn=20&rformat=json&encoding=utf8';
  const r = await H.request(u, 'http://www.kuwo.cn/', { timeout: 12000, maxSize: 4 * 1024 * 1024 });
  // 返回是单引号风格的“类 JSON”，转成标准 JSON
  const t = r.body.toString('utf8').replace(/^\uFEFF/, '');
  let j;
  try {
    j = JSON.parse(t);
  } catch (e) {
    j = JSON.parse(t.replace(/'/g, '"').replace(/,\s*([}\]])/g, '$1'));
  }
  const list = j.abslist || [];
  return list.map((s) => {
    const rid = String(s.MUSICRID || s.SONGID || '').replace(/^MUSIC_/, '');
    return {
      platform: 'kw',
      id: rid,
      name: stripTags(s.SONGNAME),
      singer: stripTags(s.ARTIST),
      album: stripTags(s.ALBUM),
      duration: parseInt(s.DURATION, 10) || 0,
      pic: '',
      musicInfo: {
        id: rid, rid, name: stripTags(s.SONGNAME), singer: stripTags(s.ARTIST),
        albumName: stripTags(s.ALBUM), duration: parseInt(s.DURATION, 10) || 0,
        songmid: rid, MusicId: rid,
      },
    };
  });
}

async function searchWy(kw, page) {
  const u = 'https://music.163.com/api/cloudsearch/pc?s=' + enc(kw) + '&type=1&offset=' + ((page - 1) * 20) +
    '&limit=20';
  const j = await H.getJson(u, {}, 'https://music.163.com/');
  const songs = (j.result && j.result.songs) || [];
  return songs.map((s) => {
    // cloudsearch 用 ar/al，老接口用 artists/album，两者都兼容
    const artists = s.ar || s.artists || [];
    const album = s.al || s.album || {};
    const names = (Array.isArray(artists) ? artists : []).map((a) => a && a.name).filter(Boolean);
    return {
      platform: 'wy',
      id: String(s.id),
      name: stripTags(s.name),
      singer: names.join(' / '),
      album: stripTags(album.name),
      duration: Math.round((s.dt || s.duration || 0) / 1000),
      pic: album.picUrl || '',
      musicInfo: {
        id: String(s.id), name: stripTags(s.name), singer: names.join(' / '),
        albumName: stripTags(album.name), duration: Math.round((s.dt || s.duration || 0) / 1000),
        artists: names.map((n, i) => ({ id: artists[i] && artists[i].id, name: n })),
      },
    };
  });
}

async function searchMg(kw, page) {
  const u = 'https://m.music.migu.cn/migu/remoting/scr_search_tag?rows=20&pgc=' + page +
    '&keyword=' + enc(kw) + '&type=2';
  const j = await H.getJson(u, {}, 'https://music.migu.cn/');
  const list = j.musics || j.data || [];
  return (Array.isArray(list) ? list : []).map((s) => ({
    platform: 'mg',
    id: String(s.copyrightId || s.id),
    name: stripTags(s.songName),
    singer: stripTags(s.singerName),
    album: stripTags(s.albumName),
    duration: 0,
    pic: s.cover || s.albumImgs || '',
    musicInfo: Object.assign({}, s, {
      id: String(s.copyrightId || s.id), name: stripTags(s.songName), singer: stripTags(s.singerName),
      albumName: stripTags(s.albumName),
    }),
  }));
}

const SEARCHERS = { kg: searchKg, kw: searchKw, tx: searchTx, wy: searchWy, mg: searchMg };

/* ---------------- 歌词 ---------------- */

async function lyricTx(id) {
  const u = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' + enc(id) +
    '&format=json&nobase64=1&songtype=0';
  const r = await H.request(u, 'https://y.qq.com/portal/player.html', { timeout: 10000, maxSize: 512 * 1024 });
  let t = r.body.toString('utf8').replace(/^\uFEFF/, '').trim();
  const m = /^\w+\((.*)\)$/.exec(t);
  if (m) t = m[1];
  const j = JSON.parse(t);
  let l = j.lyric || '';
  if (/^[A-Za-z0-9+/=]+$/.test(l.slice(0, 64))) {
    try { l = Buffer.from(l, 'base64').toString('utf8'); } catch (e) { /* 保持原样 */ }
  }
  return l;
}

async function lyricKg(hash, albumId) {
  const u = 'https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=' + enc(hash) +
    '&album_id=' + enc(albumId || '');
  const j = await H.getJson(u, {}, 'https://www.kugou.com/');
  return (j.data && j.data.lyrics) || '';
}

async function lyricWy(id) {
  const j = await H.getJson('https://music.163.com/api/song/lyric?id=' + enc(id) + '&lv=1&kv=1&tv=-1',
    {}, 'https://music.163.com/');
  return (j.lrc && j.lrc.lyric) || '';
}

async function lyricKw(rid) {
  const j = await H.getJson('https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=' + enc(rid),
    {}, 'https://www.kuwo.cn/');
  const list = (j.data && j.data.lrclist) || [];
  return list.map((l) => `[${l.time}]${l.lineLyric}`).join('\n');
}

async function lyricMg(copyrightId) {
  const j = await H.getJson('https://music.migu.cn/v3/api/music/audioPlayer/getLyric?copyrightId=' + enc(copyrightId),
    {}, 'https://music.migu.cn/');
  let l = j.lyric || j.data || '';
  if (l && /^[A-Za-z0-9+/=\s]+$/.test(String(l).slice(0, 128))) {
    try { l = Buffer.from(String(l).replace(/\s/g, ''), 'base64').toString('utf8'); } catch (e) { /* 保持原样 */ }
  }
  return l || '';
}

/* ---------------- 音频流代理（支持 Range，不断流） ---------------- */

function guessRef(u) {
  try { const p = new URL(u); return p.protocol + '//' + p.host + '/'; } catch (e) { return ''; }
}

function pipeAudio(target, ref, range, res, redirects) {
  redirects = redirects == null ? 3 : redirects;
  let parsed;
  try { parsed = new URL(target); } catch (e) {
    res.writeHead(400); res.end('bad url'); return;
  }
  const mod = parsed.protocol === 'https:' ? https : http;
  const headers = { 'User-Agent': UA, Referer: ref || guessRef(target), Accept: '*/*' };
  if (range) headers.Range = range;
  const req = mod.request({
    protocol: parsed.protocol, hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search, method: 'GET', headers,
  }, (up) => {
    if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location && redirects > 0) {
      up.resume();
      pipeAudio(new URL(up.headers.location, parsed).toString(), ref, range, res, redirects - 1);
      return;
    }
    if (up.statusCode !== 200 && up.statusCode !== 206) {
      res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
      res.end('upstream ' + up.statusCode);
      return;
    }
    const out = {
      'Content-Type': guessAudioCT(target, up.headers['content-type']),
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    if (up.headers['content-range']) out['Content-Range'] = up.headers['content-range'];
    if (up.headers['content-length']) out['Content-Length'] = up.headers['content-length'];
    res.writeHead(up.statusCode, out);
    up.pipe(res);
  });
  req.setTimeout(15000, () => req.destroy(new Error('音频拉取超时')));
  req.on('error', () => { try { res.writeHead(502); res.end('fetch error'); } catch (e) { /* 连接已断 */ } });
  req.end();
}

/* ---------------- 对外接口 ---------------- */

/* ---------------- 官方播放地址解析 ---------------- */

/** 网易云：官方 url/v1 接口，level 决定音质 */
async function urlWy(id, quality) {
  const level = quality === 'flac' ? 'lossless' : (quality === '320k' ? 'exhigh' : 'standard');
  const j = await H.getJson('https://interface.music.163.com/api/song/enhance/player/url/v1?ids=%5B' +
    enc(id) + '%5D&level=' + level + '&encodeType=' + (quality === 'flac' ? 'flac' : 'mp3'),
    {}, 'https://music.163.com/');
  const d = (j.data || [])[0];
  if (!d || !d.url) {
    if (d && d.code === 404 && quality !== '128k') return urlWy(id, '128k'); // 高音质不可用时降级
    throw new Error('该歌曲无可播音质（可能需 VIP 或已下架）');
  }
  return d.url;
}

/** 酷我：antiserver 公开转换接口，仅 mp3 可用 */
async function urlKw(rid, quality) {
  const fmt = quality === 'flac' ? 'flac' : 'mp3';
  const u = 'http://antiserver.kuwo.cn/anti.s?type=convert_url&format=' + fmt + '&response=url&rid=MUSIC_' + enc(rid);
  const r = await H.request(u, 'http://www.kuwo.cn/', { timeout: 12000, maxSize: 512 * 1024 });
  const t = r.body.toString('utf8').trim();
  if (!/^https?:\/\//i.test(t)) throw new Error('酷我拒绝：' + t.slice(0, 40));
  return t;
}

const OFFICIAL_URL = { wy: urlWy, kw: urlKw };

/** 官方接口优先，失败再走洛雪脚本；返回 { url, via } */
async function resolveUrl(platform, musicInfo, quality) {
  const errors = [];
  const fn = OFFICIAL_URL[platform];
  if (fn) {
    try {
      const id = platform === 'kw' ? (musicInfo.rid || String(musicInfo.id).replace(/^MUSIC_/, '')) : musicInfo.id;
      const u = await fn(id, quality);
      return { url: u, via: '官方接口' };
    } catch (e) { errors.push('官方接口：' + e.message); }
  }
  const rts = (await ensureAll()).filter((rt) => rt.handler);
  const known = rts.filter((rt) => rt.platforms.includes(platform));
  const ordered = known.concat(rts.filter((rt) => !rt.platforms.includes(platform)));
  for (const rt of ordered) {
    try { return { url: await callMusicUrl(rt, platform, musicInfo, quality), via: rt.name }; }
    catch (e) { errors.push((rt.name || rt.rec.id) + '：' + e.message); }
  }
  const e = new Error(errors.slice(0, 3).join('；') || '没有可用的解析通道');
  e.details = errors;
  throw e;
}

async function handleSources(q, res) {
  let rts = [];
  try { rts = await ensureAll(); } catch (e) { /* 忽略 */ }
  H.sendJson(res, 200, {
    platforms: Object.keys(PLATFORMS).map((k) => Object.assign({ key: k }, PLATFORMS[k])),
    scripts: rts.map((rt) => ({
      id: rt.rec.id, name: rt.name, version: rt.version,
      enabled: true, ok: !!rt.handler, error: rt.error || '',
      platforms: rt.platforms, codeLen: rt.codeLen || 0,
    })),
  });
}

async function handleSearch(q, res) {
  const kw = (q.kw || '').trim();
  if (!kw) return H.sendJson(res, 400, { error: '缺少关键词 kw' });
  const page = Math.max(1, parseInt(q.page || '1', 10) || 1);
  const want = (q.platform && PLATFORMS[q.platform]) ? [q.platform] : SEARCHABLE;
  const tasks = want.map(async (p) => {
    try {
      const items = await SEARCHERS[p](kw, page);
      return { platform: p, name: PLATFORMS[p].name, ok: true, items: items.slice(0, 20) };
    } catch (e) {
      return { platform: p, name: PLATFORMS[p].name, ok: false, error: e.message, items: [] };
    }
  });
  const results = await Promise.all(tasks);
  H.sendJson(res, 200, { kw, page, results });
}

async function handleUrl(q, res) {
  const platform = q.platform;
  if (!PLATFORMS[platform]) return H.sendJson(res, 400, { error: '未知平台' });
  let musicInfo;
  try { musicInfo = JSON.parse(q.info || '{}'); } catch (e) { musicInfo = {}; }
  if (!musicInfo || !musicInfo.id) return H.sendJson(res, 400, { error: '缺少歌曲信息' });

  const qualityPref = q.quality && QUALITY_ORDER.includes(q.quality)
    ? [q.quality].concat(QUALITY_ORDER.filter((x) => x !== q.quality))
    : QUALITY_ORDER.slice();
  const errors = [];
  for (const quality of qualityPref) {
    try {
      const r = await resolveUrl(platform, musicInfo, quality);
      const proxied = '/api/mplay?u=' + enc(r.url) + '&ref=' + enc(guessRef(r.url));
      return H.sendJson(res, 200, { platform, quality, via: r.via, url: proxied, src: r.url });
    } catch (e) { errors.push(quality + '：' + e.message); }
  }
  const direct = musicInfo._directUrl || musicInfo.mp3 || musicInfo.listenUrl;
  if (direct && /^https?:\/\//i.test(direct)) {
    return H.sendJson(res, 200, {
      platform, quality: '128k', via: '搜索直链',
      url: '/api/mplay?u=' + enc(direct) + '&ref=' + enc(guessRef(direct)), src: direct,
    });
  }
  H.sendJson(res, 502, { error: '解析失败：' + errors.slice(0, 3).join('；') });
}

async function handleLyric(q, res) {
  const platform = q.platform;
  let musicInfo;
  try { musicInfo = JSON.parse(q.info || '{}'); } catch (e) { musicInfo = {}; }
  const id = (musicInfo && musicInfo.id) || q.id || '';
  try {
    let lrc = '';
    if (platform === 'tx') lrc = await lyricTx(id);
    else if (platform === 'kg') lrc = await lyricKg(musicInfo.hash || musicInfo.FileHash || id, musicInfo.albumId || musicInfo.AlbumID || '');
    else if (platform === 'wy') lrc = await lyricWy(id);
    else if (platform === 'kw') lrc = await lyricKw(musicInfo.rid || id);
    else if (platform === 'mg') lrc = await lyricMg(id);
    H.sendJson(res, 200, { platform, lyric: lrc || '' });
  } catch (e) {
    H.sendJson(res, 200, { platform, lyric: '', error: e.message });
  }
}

async function handleAudio(q, req, res) {
  const u = q.u;
  if (!u || !/^https?:\/\//i.test(u)) return H.sendJson(res, 400, { error: '非法的音频地址' });
  pipeAudio(u, q.ref || '', req.headers.range || '', res);
}

module.exports = { init, handleSources, handleSearch, handleUrl, handleLyric, handleAudio };
