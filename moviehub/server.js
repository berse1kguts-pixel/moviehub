#!/usr/bin/env node
/**
 * 观影中心 —— 本地影视聚合播放服务（零依赖，仅需 Node.js）
 *
 * 功能：
 *   1. 聚合多个苹果CMS V10 采集接口，统一搜索 / 浏览 / 详情
 *   2. 图片代理（解决台标/海报防盗链）
 *   3. m3u8 代理播放（重写播放列表与分片地址，解决浏览器跨域与 Referer 限制）
 *
 * 启动：node server.js        （默认端口 7000，可用 PORT=8080 node server.js 修改）
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 7000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SOURCES_FILE = path.join(ROOT, 'sources.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

/* ---------------- 配置 ---------------- */

function loadSources() {
  try {
    const raw = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
    return raw.sources.filter((s) => s.enabled !== false);
  } catch (e) {
    console.error('[配置] sources.json 读取失败：', e.message);
    return [];
  }
}
let SOURCES = loadSources();

/* ---------------- 音乐模块 ---------------- */
const music = require('./music.js');
music.init({ request, getJson, sendJson });
const spotify = require('./spotify.js');
spotify.init({ request, getJson, sendJson });

/* ---------------- 网络请求 ---------------- */

/** 发起 HTTP(S) 请求，自动跟随重定向；返回 { status, headers, body(Buffer), finalUrl } */
function request(target, referer, opts = {}) {
  return new Promise((resolve, reject) => {
    let redirects = opts.redirects == null ? 3 : opts.redirects;
    const timeout = opts.timeout || 12000;
    const attempt = (u) => {
      let parsed;
      try { parsed = new URL(u); } catch (e) { reject(new Error('非法的 URL: ' + u)); return; }
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: opts.method || 'GET',
        headers: Object.assign({
          'User-Agent': UA,
          Accept: '*/*',
          Referer: referer || parsed.protocol + '//' + parsed.host + '/',
        }, opts.headers || {}),
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          redirects -= 1;
          try { attempt(new URL(res.headers.location, parsed).toString()); } catch (e) { reject(e); }
          return;
        }
        const chunks = [];
        let size = 0;
        const maxSize = opts.maxSize || 32 * 1024 * 1024;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxSize) { req.destroy(new Error('响应过大')); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), finalUrl: u }));
      });
      req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
      if (opts.body != null) req.write(opts.body);
      req.end();
    };
    attempt(target);
  });
}

/** 请求并解析 JSON（带一次重试，应对资源站 WAF 偶发拒绝） */
async function getJson(api, params, referer) {
  const sep = api.includes('?') ? '&' : '?';
  const qs = new URLSearchParams(params).toString();
  const url = api + sep + qs;
  let lastErr;
  for (let i = 0; i < 2; i += 1) {
    try {
      const r = await request(url, referer, { timeout: 15000, maxSize: 24 * 1024 * 1024 });
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      return JSON.parse(r.body.toString('utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      lastErr = e;
      if (i === 0) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw lastErr;
}

/* ---------------- 数据解析 ---------------- */

/** 片名归一化：去括号补充说明、去清晰度标签，用于多源合并 */
function normalizeName(n) {
  return String(n || '')
    .replace(/[（(【\[][^)）】\]]*[)）】\]]/g, '')
    .replace(/\s+/g, '')
    .replace(/(4k|2160p|1080p|720p|hd|bd|国语|粤语|英语|中字|高清|超清|蓝光|无删减|完整版|正片|预告|纪录片)/gi, '')
    .toLowerCase();
}

/**
 * 解析 vod_play_url → 线路数组
 * 格式：线路A$集1#集2#集3$$$线路B$集1#集2   （每集可能是  标题$地址  或纯地址）
 */
function parsePlayGroups(playFrom, playUrl) {
  if (!playUrl) return [];
  const lines = [];
  for (const raw of String(playUrl).split('$$$')) {
    const g = raw.trim();
    if (!g) continue;
    let flag = playFrom || '线路';
    let list = g;
    if (!/^https?:\/\//i.test(g)) {
      const i = g.indexOf('$');
      if (i > 0) { flag = g.slice(0, i).trim() || flag; list = g.slice(i + 1); }
    }
    const episodes = [];
    for (const seg of list.split('#')) {
      const s = seg.trim();
      if (!s) continue;
      let title = '';
      let u = s;
      const j = s.lastIndexOf('$');
      if (j > 0) {
        const maybe = s.slice(j + 1);
        if (/^https?:\/\//i.test(maybe)) { title = s.slice(0, j).trim(); u = maybe; }
      }
      if (/^https?:\/\//i.test(u)) episodes.push({ title, url: u });
    }
    if (episodes.length) lines.push({ flag, episodes });
  }
  return lines;
}

function mapItem(v, s) {
  return {
    name: v.vod_name,
    pic: v.vod_pic,
    remarks: v.vod_remarks,
    content: v.vod_content,
    year: v.vod_year,
    area: v.vod_area,
    actor: v.vod_actor,
    director: v.vod_director,
    typeName: v.type_name,
    source: s.id,
    sourceName: s.name,
    vodId: v.vod_id,
    lines: parsePlayGroups(v.vod_play_from, v.vod_play_url),
  };
}

/* ---------------- 豆瓣热榜 ---------------- */

const DOUBAN_TAGS = {
  movie: ['热门', '最新', '豆瓣高分', '冷门佳片', '经典'],
  tv: ['热门', '国产剧', '美剧', '日剧', '韩剧', '日本动画', '综艺'],
};
const DOUBAN_REF = 'https://m.douban.com/';
const doubanCache = new Map();

/**
 * 豆瓣热榜：代理 m.douban.com 的 rexxar 模块接口，聚合并返回榜单影片。
 * 含：热门 gaia 模块 + 实时热门/一周口碑/Top250 等精选榜，按 id 去重。
 */
async function handleDouban(q, res) {
  const type = q.type === 'tv' ? 'tv' : 'movie';
  const tag = String(q.tag || '热门').slice(0, 12);
  const limit = Math.min(50, Math.max(1, parseInt(q.limit || '24', 10) || 24));
  const key = type + '|' + tag + '|' + limit;
  const hit = doubanCache.get(key);
  if (hit && Date.now() - hit.t < 15 * 60 * 1000) return sendJson(res, 200, hit.data);

  const url = 'https://m.douban.com/rexxar/api/v2/' + type + '/modules?type=' + encodeURIComponent(type) +
    '&tag=' + encodeURIComponent(tag) + '&page_limit=' + limit + '&page_start=0';
  let r;
  try {
    r = await request(url, DOUBAN_REF, { timeout: 12000, maxSize: 8 * 1024 * 1024 });
  } catch (e) {
    return sendJson(res, 502, { error: '豆瓣接口连接失败：' + e.message });
  }
  if (r.status !== 200) return sendJson(res, 502, { error: '豆瓣接口 HTTP ' + r.status });
  let j;
  try {
    j = JSON.parse(r.body.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return sendJson(res, 502, { error: '豆瓣返回解析失败' });
  }

  const seen = new Set();
  const items = [];
  const push = (s) => {
    if (!s || !s.title) return;
    const id = String(s.id || s.uri || s.title);
    if (seen.has(id)) return;
    seen.add(id);
    const cover = (s.cover && (s.cover.url || (s.cover.info && s.cover.info.url))) ||
      (s.pic && (s.pic.normal || s.pic.large)) || '';
    items.push({
      id: s.id || '',
      title: s.title,
      rate: (s.rating && s.rating.value) || 0,
      year: s.year || '',
      cover,
      url: s.url || '',
      subtitle: s.card_subtitle || '',
    });
  };
  (j.modules || []).forEach((m) => {
    const d = m && m.data;
    if (!d) return;
    if (Array.isArray(d.subjects)) d.subjects.forEach(push);
    if (Array.isArray(d.selected_collections)) {
      d.selected_collections.forEach((c) => { if (Array.isArray(c.items)) c.items.forEach(push); });
    }
    if (Array.isArray(d.subject_collection_boards)) {
      d.subject_collection_boards.forEach((b) => {
        if (Array.isArray(b.items)) b.items.forEach(push);
        if (b.subject_collection && Array.isArray(b.subject_collection.items)) b.subject_collection.items.forEach(push);
      });
    }
  });
  const data = { type, tag, tags: DOUBAN_TAGS[type], total: items.length, items: items.slice(0, limit + 10) };
  doubanCache.set(key, { t: Date.now(), data });
  sendJson(res, 200, data);
}

/* ---------------- 分类浏览 ---------------- */

const catCache = new Map(); // srcId -> { t, version, types, groups, top, done }

/** 默认浏览源：片库最大的一个 */
function defaultBrowseSource() {
  const prefer = ['bfzy', 'lzzy', '360zy', 'snzy'];
  for (const id of prefer) {
    const s = SOURCES.find((x) => x.id === id);
    if (s) return s;
  }
  return SOURCES[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 分类树发现：先快速采样（4 页，约 3 秒）立刻返回，
 * 剩余采集在后台继续，完成后 version +1，前端轮询到新版本即刷新。
 * 这样首屏永远不会卡死，树会随时间变完整。
 */
async function discoverTypes(s, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const types = new Map();
  const absorb = (list) => {
    let added = 0;
    for (const it of (list || [])) {
      const id = it.type_id;
      if (id == null) continue;
      if (!types.has(id)) {
        types.set(id, { id, pid: it.type_id_1 || 0, name: it.type_name || ('分类' + id), n: 0 });
        added += 1;
      }
      types.get(id).n += 1;
    }
    return added;
  };

  // 阶段一：通用列表采样（最新排序）
  let stale = 0;
  for (let pg = 1; pg <= 12 && stale < 2; pg += 1) {
    if (Date.now() > deadline) break;
    let j;
    try { j = await getJson(s.api, { ac: 'videolist', pg }, s.api); } catch (e) { break; }
    const list = Array.isArray(j.list) ? j.list : [];
    if (!list.length) break;
    stale = absorb(list) ? 0 : stale + 1;
    await sleep(150);
  }

  // 阶段二：按已发现的父级逐类翻页，补齐同级分类
  const parents = [...new Set([...types.values()].map((t) => t.pid).filter((p) => p && p > 0))];
  for (const pid of parents) {
    if (Date.now() > deadline) break;
    let s2 = 0;
    for (let pg = 1; pg <= 6 && s2 < 2; pg += 1) {
      if (Date.now() > deadline) break;
      let j;
      try { j = await getJson(s.api, { ac: 'videolist', t: pid, pg }, s.api); } catch (e) { break; }
      const list = Array.isArray(j.list) ? j.list : [];
      if (!list.length) break;
      s2 = absorb(list) ? 0 : s2 + 1;
      await sleep(180);
    }
  }
  return [...types.values()];
}

/** 用 t=<pid> 的首条数据反查父级分类名（并发受限） */
async function fillParentNames(s, types) {
  const pids = [...new Set(types.map((t) => t.pid).filter((p) => p > 0))];
  const known = new Set(types.map((t) => t.id));
  const todo = pids.filter((p) => !known.has(p));
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const pid = todo[i]; i += 1;
      try {
        const j = await getJson(s.api, { ac: 'videolist', t: pid, pg: 1 }, s.api);
        const first = (j.list || [])[0];
        if (first && first.type_name) out.push({ id: pid, pid: 0, name: first.type_name, n: 0, isParent: true });
      } catch (e) { /* 忽略单个失败 */ }
      await sleep(120);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return types.concat(out);
}

function buildTree(types) {
  const byPid = new Map();
  types.forEach((t) => {
    const k = t.pid || 0;
    if (!byPid.has(k)) byPid.set(k, []);
    byPid.get(k).push(t);
  });
  byPid.forEach((list) => list.sort((a, b) => (b.n - a.n)));
  const nameOf = (pid) => {
    const p = types.find((t) => t.id === pid);
    return p ? p.name : '分组' + pid;
  };
  const groups = [...byPid.entries()]
    .filter(([pid]) => pid !== 0)
    .map(([pid, list]) => ({ pid, name: nameOf(pid), items: list }))
    .sort((a, b) => b.items.length - a.items.length);
  const top = byPid.get(0) || [];
  return { groups, top };
}

/** 后台补全：不阻塞响应 */
function enrichInBackground(s, entry) {
  if (entry.busy || entry.done) return;
  entry.busy = true;
  (async () => {
    try {
      const more = await discoverTypes(s, 45000);
      const merged = new Map();
      entry.types.forEach((t) => merged.set(t.id, t));
      more.forEach((t) => { if (!merged.has(t.id)) merged.set(t.id, t); });
      const all = await fillParentNames(s, [...merged.values()]);
      const tree = buildTree(all);
      entry.types = all;
      entry.groups = tree.groups;
      entry.top = tree.top;
      entry.version += 1;
      entry.t = Date.now();
      entry.done = true;
      saveCatDisk(s.id, entry);
    } catch (e) { /* 保留已有结果 */ }
    entry.busy = false;
  })();
}

const CAT_DIR = path.join(ROOT, '.cache', 'classes');

/** 分类树磁盘缓存：避免每次重启都重新采样 */
function loadCatDisk(srcId) {
  try {
    const p = path.join(CAT_DIR, srcId + '.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && j.types && j.types.length && Date.now() - j.t < 7 * 24 * 3600 * 1000) return j;
  } catch (e) { /* 无缓存 */ }
  return null;
}

function saveCatDisk(srcId, entry) {
  try {
    if (!fs.existsSync(CAT_DIR)) fs.mkdirSync(CAT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CAT_DIR, srcId + '.json'), JSON.stringify({
      t: Date.now(), types: entry.types, groups: entry.groups, top: entry.top,
    }));
  } catch (e) { /* 忽略 */ }
}

async function handleClasses(q, res) {
  const s = SOURCES.find((x) => x.id === q.src) || defaultBrowseSource();
  if (!s) return sendJson(res, 500, { error: '没有可用源' });
  let entry = catCache.get(s.id);
  const fresh = entry && Date.now() - entry.t < 24 * 3600 * 1000;

  if (!fresh) {
    // 磁盘缓存命中：直接返回，后台继续补全
    const disk = loadCatDisk(s.id);
    if (disk) {
      entry = {
        t: Date.now(), version: 1, done: true, busy: false,
        types: disk.types, groups: disk.groups, top: disk.top,
      };
      catCache.set(s.id, entry);
    } else {
      // 快速采样：预算 6 秒 / 最多 8 页，保证首包不卡死
      const types = await discoverTypes(s, 6000);
      if (!types.length) {
        if (entry) { /* 用旧数据兜底 */ } else {
          return sendJson(res, 502, { error: '源 ' + s.name + ' 没有返回分类数据，换个源试试' });
        }
      } else {
        const withNames = await fillParentNames(s, types);
        const tree = buildTree(withNames);
        entry = {
          t: Date.now(), version: 1, done: false, busy: false,
          types: withNames, groups: tree.groups, top: tree.top,
        };
        catCache.set(s.id, entry);
      }
    }
  }
  if (entry && !entry.done) enrichInBackground(s, entry);
  sendJson(res, 200, {
    src: s.id, srcName: s.name,
    version: entry.version, done: !!entry.done,
    types: entry.types, groups: entry.groups, top: entry.top,
  });
}

/** 分类浏览：t=分类ID pg=页码 year=年份 by=排序（部分源支持） */
async function handleBrowse(q, res) {
  const s = SOURCES.find((x) => x.id === q.src) || defaultBrowseSource();
  if (!s) return sendJson(res, 500, { error: '没有可用源' });
  const t = q.t;
  const pg = Math.max(1, parseInt(q.pg || '1', 10) || 1);
  const params = { ac: 'videolist', pg };
  if (t) params.t = t;
  if (q.year) params.year = q.year;
  if (q.by) params.by = q.by;
  let j;
  try {
    j = await getJson(s.api, params, s.api);
  } catch (e) {
    return sendJson(res, 502, { error: '源 ' + s.name + ' 请求失败：' + e.message });
  }
  const items = (Array.isArray(j.list) ? j.list : []).map((v) => mapItem(v, s));
  // 当前分类名（取第一项的 type_name，或从缓存里查）
  let typeName = '';
  if (items.length) typeName = items[0].typeName || '';
  const cached = catCache.get(s.id);
  if (!typeName && t && cached) {
    const found = cached.types.find((x) => String(x.id) === String(t));
    if (found) typeName = found.name;
  }
  sendJson(res, 200, {
    src: s.id, srcName: s.name, typeId: t || '', typeName,
    page: pg, pagecount: j.pagecount || 1, total: j.total || items.length,
    items,
  });
}

/* ---------------- 响应工具 ---------------- */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/* ---------------- API 处理 ---------------- */

async function handleSearch(q, res) {
  const wd = (q.wd || '').trim();
  if (!wd) return sendJson(res, 400, { error: '缺少关键词 wd' });
  const sources = q.src ? SOURCES.filter((s) => s.id === q.src) : SOURCES;

  const tasks = sources.map(async (s) => {
    try {
      let j = await getJson(s.api, { ac: 'detail', wd }, s.api);
      let list = Array.isArray(j.list) ? j.list : [];
      if (!list.length) { // 个别站点搜索参数不同，回退 ac=list
        j = await getJson(s.api, { ac: 'list', wd }, s.api);
        list = Array.isArray(j.list) ? j.list : [];
      }
      return list.slice(0, 40).map((v) => mapItem(v, s)).filter((x) => x.lines.length);
    } catch (e) {
      return [];
    }
  });
  const groups = await Promise.all(tasks);

  const merged = new Map();
  let hitSources = 0;
  for (let i = 0; i < sources.length; i += 1) {
    const items = groups[i];
    if (items.length) hitSources += 1;
    for (const it of items) {
      const key = normalizeName(it.name) || it.name;
      const exist = merged.get(key);
      if (!exist) {
        merged.set(key, {
          name: it.name, pic: it.pic, remarks: it.remarks, content: it.content,
          year: it.year, area: it.area, actor: it.actor, typeName: it.typeName,
          sources: [{ id: it.source, name: it.sourceName, vodId: it.vodId, lines: it.lines }],
        });
      } else {
        exist.sources.push({ id: it.source, name: it.sourceName, vodId: it.vodId, lines: it.lines });
        if (!exist.pic && it.pic) exist.pic = it.pic;
        if ((!exist.remarks || exist.remarks === '更新至') && it.remarks) exist.remarks = it.remarks;
        if ((!exist.content || exist.content === '') && it.content) exist.content = it.content;
      }
    }
  }
  const items = [...merged.values()].sort((a, b) =>
    (b.sources.length - a.sources.length) || String(a.name).localeCompare(String(b.name), 'zh'));
  sendJson(res, 200, { kw: wd, total: items.length, hitSources, sourceCount: sources.length, items });
}

async function handleDetail(q, res) {
  const s = SOURCES.find((x) => x.id === q.src);
  if (!s) return sendJson(res, 400, { error: '源不存在：' + q.src });
  if (!q.id) return sendJson(res, 400, { error: '缺少 id' });
  const j = await getJson(s.api, { ac: 'detail', ids: q.id }, s.api);
  const v = (j.list || [])[0];
  if (!v) return sendJson(res, 404, { error: '影片不存在或已下架' });
  sendJson(res, 200, mapItem(v, s));
}

async function handleLatest(q, res) {
  const s = SOURCES.find((x) => x.id === q.src) || SOURCES[0];
  if (!s) return sendJson(res, 500, { error: '没有可用源' });
  const pg = Math.max(1, parseInt(q.pg || '1', 10) || 1);
  const j = await getJson(s.api, { ac: 'list', pg }, s.api);
  const items = (j.list || []).map((v) => mapItem(v, s));
  sendJson(res, 200, { page: pg, pagecount: j.pagecount, total: j.total, items });
}

async function handleImg(q, res) {
  const u = q.u;
  if (!u || !/^https?:\/\//i.test(u)) return sendJson(res, 400, { error: '非法的图片地址' });
  try {
    const r = await request(u, q.ref || guessRef(u), { timeout: 10000, maxSize: 8 * 1024 * 1024 });
    res.writeHead(r.status === 200 ? 200 : r.status, {
      'Content-Type': r.headers['content-type'] || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(r.body);
  } catch (e) {
    sendJson(res, 502, { error: e.message });
  }
}

/** m3u8 代理：重写播放列表中的分片/子列表/密钥地址到本地；其余二进制（ts 等）直接透传 */
async function handlePlay(q, res) {
  const u = q.url;
  if (!u || !/^https?:\/\//i.test(u)) return sendJson(res, 400, { error: '非法的播放地址' });
  const ref = q.ref || '';
  let r;
  try {
    r = await request(u, ref, { timeout: 15000, maxSize: 48 * 1024 * 1024 });
  } catch (e) {
    return sendJson(res, 502, { error: '拉取失败：' + e.message });
  }
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Accept-Ranges': 'none' };
  const ct = r.headers['content-type'] || '';
  const head = r.body.slice(0, 16).toString('latin1');
  const isM3u8 = /mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(u) || head.indexOf('#EXTM3U') === 0;

  if (isM3u8) {
    let base;
    try { base = new URL(r.finalUrl || u); } catch (e) { base = null; }
    const refFinal = ref || (base ? base.protocol + '//' + base.host + '/' : '');
    const text = r.body.toString('utf8').split(/\r?\n/).map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.charAt(0) === '#') {
        return line.replace(/URI="([^"]+)"/g, (m, uri) => 'URI="' + toProxy(uri, base, refFinal) + '"');
      }
      return toProxy(t, base, refFinal);
    }).join('\n');
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/vnd.apple.mpegurl' }, cors));
    return res.end(text);
  }
  res.writeHead(r.status, Object.assign({ 'Content-Type': ct || 'video/mp2t', 'Cache-Control': 'no-store' }, cors));
  res.end(r.body);
}

function toProxy(uri, base, ref) {
  let abs;
  try { abs = base ? new URL(uri, base).toString() : uri; } catch (e) { return uri; }
  return '/api/play?url=' + encodeURIComponent(abs) + '&ref=' + encodeURIComponent(ref);
}

/** 根据播放地址猜 Referer：取源站origin */
function guessRef(u) {
  try { const p = new URL(u); return p.protocol + '//' + p.host + '/'; } catch (e) { return ''; }
}

/* ---------------- 静态文件 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

function serveStatic(res, pathname) {
  let p = pathname;
  try { p = decodeURIComponent(pathname); } catch (e) { /* 保留原样 */ }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------------- 服务入口 ---------------- */

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const p = parsed.pathname;
  const q = {};
  parsed.searchParams.forEach((v, k) => { q[k] = v; });
  try {
    if (p === '/api/sources') return sendJson(res, 200, { sources: SOURCES });
    if (p === '/api/search') return await handleSearch(q, res);
    if (p === '/api/detail') return await handleDetail(q, res);
    if (p === '/api/latest') return await handleLatest(q, res);
    if (p === '/api/douban') return await handleDouban(q, res);
    if (p === '/api/classes') return await handleClasses(q, res);
    if (p === '/api/browse') return await handleBrowse(q, res);
    if (p === '/api/img') return await handleImg(q, res);
    if (p === '/api/play') return await handlePlay(q, res);
    if (p === '/api/music/sources') return await music.handleSources(q, res);
    if (p === '/api/music/search') return await music.handleSearch(q, res);
    if (p === '/api/music/url') return await music.handleUrl(q, res);
    if (p === '/api/music/lyric') return await music.handleLyric(q, res);
    if (p === '/api/mplay') return await music.handleAudio(q, req, res);
    if (p === '/api/spotify/status') return await spotify.handleStatus(q, res);
    if (p === '/api/spotify/login') return await spotify.handleLogin(q, res);
    if (p === '/api/spotify/callback') return await spotify.handleCallback(q, res);
    if (p === '/api/spotify/logout') return await spotify.handleLogout(q, res);
    if (p === '/api/spotify/search') return await spotify.handleSearch(q, res);
    if (p === '/api/spotify/playlists') return await spotify.handlePlaylists(q, res);
    if (p === '/api/spotify/playlist') return await spotify.handlePlaylistTracks(q, res);
    if (p === '/api/spotify/start') return await spotify.handleStart(q, res);
    if (p === '/api/spotify/stop') return await spotify.handleStop(q, res);
    if (p === '/api/spotify/play') return await spotify.handlePlay(q, res);
    if (p === '/api/spotify/player') return await spotify.handlePlayer(Object.assign(q, { _method: req.method }), res);
    if (p.indexOf('/api/') === 0) return sendJson(res, 404, { error: '未知接口' });
    return serveStatic(res, p);
  } catch (e) {
    sendJson(res, 500, { error: e.message || '服务异常' });
  }
});

function start(port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const line = '════════════════════════════════════════';
      console.log(line);
      console.log('  🎬 观影中心已启动');
      console.log('  本机访问：  http://localhost:' + port);
      console.log('  电视/手机： http://<本机局域网IP>:' + port);
      console.log('  可用源：    ' + SOURCES.map((s) => s.name).join('、'));
      console.log(line);
      resolve(port);
    });
  });
}

if (require.main === module) {
  start(PORT).catch((e) => { console.error('启动失败：' + e.message); process.exit(1); });
}

module.exports = { start, request, getJson, sendJson };
