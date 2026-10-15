// Sobtechno Video Downloader — background service worker
// Sniffs media requests (mp4/webm/m3u8/mpd), keeps a per-tab list, runs downloads.
// Author: Sobtechno
import { fetchText, isMaster, parseMaster, parseMedia } from './hls.js';

const MIN_FILE_SIZE = 300 * 1024; // ignore tiny fragments/ads
const jobs = new Map();           // item id -> { state, pct, text }
const jobRules = new Map();       // item id -> DNR rule ids
const pendingBlobs = new Map();   // downloadId -> { id, url }
const loads = new Map();          // tabId -> Promise<Map>
const timers = new Map();
let enabledCache = null;

/* ---------- helpers ---------- */
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const strip = (u) => u.split('#')[0];
const uid = (u) => 'u' + hash(strip(u));
const extOf = (u) => { try { return (new URL(u).pathname.match(/\.([a-z0-9]{2,4})$/i) || [])[1]?.toLowerCase() || ''; } catch { return ''; } };
const CT_EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'video/quicktime': 'mov', 'video/x-flv': 'flv' };
const safeName = (s) => (s || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
const rid = () => Math.floor(Math.random() * 1e9) + 1;

async function isEnabled() {
  if (enabledCache === null) enabledCache = (await chrome.storage.local.get('enabled')).enabled !== false;
  return enabledCache;
}

/* ---------- per-tab store (memory + storage.session) ---------- */
function load(tabId) {
  if (!loads.has(tabId)) {
    loads.set(tabId, (async () => {
      const k = 'm' + tabId;
      const r = await chrome.storage.session.get(k);
      return new Map(Object.entries(r[k] || {}));
    })());
  }
  return loads.get(tabId);
}
function persist(tabId, m) {
  clearTimeout(timers.get(tabId));
  timers.set(tabId, setTimeout(() => chrome.storage.session.set({ ['m' + tabId]: Object.fromEntries(m) }).catch(() => {}), 300));
}
function badge(tabId, m) {
  const n = [...m.values()].filter((i) => !i.hidden).length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#e11d2e' }).catch(() => {});
}
const notify = (tabId) => chrome.runtime.sendMessage({ action: 'update', tabId }).catch(() => {});

async function upsert(tabId, patch) {
  const m = await load(tabId);
  const old = m.get(patch.id) || {};
  const next = { ...old, ...patch, ts: old.ts || Date.now() };
  for (const k of Object.keys(patch)) if ((patch[k] === '' || patch[k] == null || patch[k] === 0) && old[k]) next[k] = old[k];
  m.set(next.id, next);
  persist(tabId, m); badge(tabId, m); notify(tabId);
  return next;
}

async function clearTab(tabId) {
  loads.set(tabId, Promise.resolve(new Map()));
  chrome.storage.session.remove('m' + tabId).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  notify(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => { loads.delete(tabId); chrome.storage.session.remove('m' + tabId).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading' && info.url) clearTab(tabId); });
chrome.runtime.onStartup.addListener(clearRules);
chrome.runtime.onInstalled.addListener(clearRules);
async function clearRules() {
  const r = await chrome.declarativeNetRequest.getSessionRules();
  if (r.length) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: r.map((x) => x.id) });
}

/* ---------- Referer spoofing for extension-originated requests ---------- */
async function refererRule(pageUrl, ttl) {
  if (!pageUrl || !/^https?:/.test(pageUrl)) return [];
  const origin = new URL(pageUrl).origin;
  const a = rid(), b = rid();
  const cond = (types) => ({ tabIds: [-1], resourceTypes: types });
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [
      { id: a, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: pageUrl }] }, condition: cond(['xmlhttprequest', 'media', 'other']) },
      { id: b, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'set', value: origin }] }, condition: cond(['xmlhttprequest']) },
    ],
  });
  const ids = [a, b];
  if (ttl) setTimeout(() => dropRules(ids), ttl);
  return ids;
}
const dropRules = (ids) => ids?.length && chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }).catch(() => {});

/* ---------- network sniffing ---------- */
chrome.webRequest.onResponseStarted.addListener(async (d) => {
  try {
    if (d.tabId < 0 || ![200, 206].includes(d.statusCode) || !(await isEnabled())) return;
    const h = (n) => d.responseHeaders?.find((x) => x.name.toLowerCase() === n)?.value || '';
    const ct = h('content-type').toLowerCase().split(';')[0].trim();
    const path = new URL(d.url).pathname.toLowerCase();

    let kind = null;
    if (/\.m3u8$/.test(path) || /mpegurl/.test(ct)) kind = 'hls';
    else if (/\.mpd$/.test(path) || /dash\+xml/.test(ct)) kind = 'dash';
    else if ((/\.(mp4|webm|mkv|mov|m4v|flv|3gp)$/.test(path) || ct.startsWith('video/')) && ct !== 'video/mp2t') kind = 'file';
    if (!kind) return;

    let size = +h('content-length') || 0;
    const cr = h('content-range').match(/\/(\d+)$/);
    if (cr) size = +cr[1];
    if (kind === 'file' && size && size < MIN_FILE_SIZE) return;

    const tab = await chrome.tabs.get(d.tabId).catch(() => null);
    const m = await load(d.tabId);
    const id = uid(d.url);
    const hidden = kind === 'hls' && [...m.values()].some((x) => x.variants?.some((v) => strip(v.url) === strip(d.url)));
    const item = await upsert(d.tabId, {
      id, kind, url: d.url, size, hidden,
      ext: kind === 'file' ? extOf(d.url) || CT_EXT[ct] || 'mp4' : '',
      title: tab?.title || '', pageUrl: tab?.url || '', source: 'network',
    });
    if (kind === 'hls' && !item.probed && !hidden) probe(d.tabId, item);
  } catch { /* ignore */ }
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }, ['responseHeaders']);

/** Read an HLS playlist: qualities, duration, live/DRM flags; hide child playlists of a master */
async function probe(tabId, item) {
  await upsert(tabId, { id: item.id, probed: true });
  const rules = await refererRule(item.pageUrl, 10000);
  try {
    const text = await fetchText(item.url);
    if (isMaster(text)) {
      const { variants, audioSeparate } = parseMaster(text, item.url);
      await upsert(tabId, { id: item.id, variants, audioSeparate, isMaster: true });
      const m = await load(tabId);
      for (const v of variants) {
        const c = m.get(uid(v.url));
        if (c && c.id !== item.id) await upsert(tabId, { id: c.id, hidden: true });
      }
    } else {
      const pl = parseMedia(text, item.url);
      await upsert(tabId, { id: item.id, duration: Math.round(pl.duration), live: pl.live, drm: pl.drm });
    }
  } catch { /* keep item, probe is best-effort */ }
  finally { dropRules(rules); }
}

/* ---------- jobs ---------- */
function setJob(id, job) {
  jobs.set(id, job);
  chrome.runtime.sendMessage({ action: 'job', id, job }).catch(() => {});
}

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Merge downloaded HLS segments into a single file' });
}
let closeTimer;
function scheduleClose() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(async () => {
    const running = [...jobs.values()].some((j) => j.state === 'run');
    if (!running && !pendingBlobs.size) chrome.offscreen.closeDocument().catch(() => {});
  }, 20000);
}

async function startDownload(tabId, id, opts = {}) {
  const m = await load(tabId);
  const it = m.get(id);
  if (!it) throw new Error('مورد پیدا نشد');
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const name = safeName(it.title || tab?.title);
  const page = it.pageUrl || tab?.url;

  if (it.kind === 'file') {
    await refererRule(page, 20000);
    try {
      await chrome.downloads.download({ url: it.url, filename: `${name}.${it.ext || 'mp4'}`, conflictAction: 'uniquify' });
      setJob(id, { state: 'done', pct: 100, text: 'دانلود شروع شد' });
    } catch (e) { setJob(id, { state: 'error', text: 'دانلود شروع نشد: ' + e.message }); }
    return;
  }
  if (it.kind === 'hls') {
    setJob(id, { state: 'run', pct: 0, text: 'آماده‌سازی…' });
    await ensureOffscreen();
    jobRules.set(id, await refererRule(page, 0));
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'hls', id, url: it.url, variantUrl: opts.variantUrl, name });
    return;
  }
  throw new Error('این نوع مستقیم دانلود نمی‌شود؛ از «ضبط» استفاده کن');
}

chrome.downloads.onChanged.addListener((d) => {
  const p = pendingBlobs.get(d.id);
  if (p && d.state && ['complete', 'interrupted'].includes(d.state.current)) {
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'revoke', url: p.url }).catch(() => {});
    setJob(p.id, d.state.current === 'complete' ? { state: 'done', pct: 100, text: 'ذخیره شد' } : { state: 'error', text: 'ذخیره ناموفق بود' });
    pendingBlobs.delete(d.id);
    scheduleClose();
  }
});

/* ---------- messages ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return false;
  (async () => {
    try { sendResponse(await handle(msg, sender)); }
    catch (e) { sendResponse({ error: String(e.message || e) }); }
  })();
  return true;
});

async function handle(msg, sender) {
  switch (msg.action) {
    case 'domVideos': {
      const tabId = sender.tab?.id;
      if (tabId == null || !(await isEnabled())) return {};
      for (const v of msg.videos) {
        const src = v.src || '';
        let kind = 'record', id = `v${sender.frameId}_${v.vid}`, url = '';
        if (/^https?:/i.test(src)) {
          const p = new URL(src).pathname.toLowerCase();
          kind = /\.m3u8$/.test(p) ? 'hls' : /\.mpd$/.test(p) ? 'dash' : 'file';
          id = uid(src); url = src;
        }
        const item = await upsert(tabId, {
          id, kind, url, frameId: sender.frameId, vid: v.vid, poster: v.poster, duration: v.duration,
          h: v.h, title: v.title, pageUrl: sender.tab.url, source: 'dom',
          ext: kind === 'file' ? extOf(src) || 'mp4' : '',
        });
        if (kind === 'hls' && !item.probed) probe(tabId, item);
      }
      return {};
    }
    case 'recState': {
      const tabId = sender.tab?.id;
      if (tabId != null) await upsert(tabId, { id: `v${sender.frameId}_${msg.vid}`, recording: !!msg.recording });
      return {};
    }
    case 'list': {
      const m = await load(msg.tabId);
      const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
      const items = [...m.values()].filter((i) => !i.hidden).sort((a, b) => b.ts - a.ts)
        .map((i) => ({ ...i, title: i.title || tab?.title || 'video' }));
      return { items, enabled: await isEnabled(), jobs: Object.fromEntries(jobs) };
    }
    case 'setEnabled':
      enabledCache = !!msg.value;
      await chrome.storage.local.set({ enabled: enabledCache });
      return { enabled: enabledCache };
    case 'clear':
      await clearTab(msg.tabId);
      return {};
    case 'download':
      await startDownload(msg.tabId, msg.id, { variantUrl: msg.variantUrl });
      return {};
    case 'cancel':
      chrome.runtime.sendMessage({ target: 'offscreen', action: 'cancel', id: msg.id }).catch(() => {});
      return {};
    case 'recStart':
    case 'recStop': {
      const it = (await load(msg.tabId)).get(msg.id);
      if (!it) throw new Error('مورد پیدا نشد');
      const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
      const r = await chrome.tabs.sendMessage(msg.tabId, { action: msg.action, vid: it.vid, title: safeName(it.title || tab?.title) }, { frameId: it.frameId });
      if (r?.error) throw new Error(r.error);
      return {};
    }
    /* from offscreen */
    case 'progress': setJob(msg.id, { state: 'run', pct: msg.pct, text: msg.text }); return {};
    case 'done': {
      dropRules(jobRules.get(msg.id)); jobRules.delete(msg.id);
      try {
        const did = await chrome.downloads.download({ url: msg.blobUrl, filename: `${msg.name}.${msg.ext}`, conflictAction: 'uniquify' });
        pendingBlobs.set(did, { id: msg.id, url: msg.blobUrl });
        setJob(msg.id, { state: 'run', pct: 100, text: 'در حال ذخیره…' });
      } catch (e) { setJob(msg.id, { state: 'error', text: 'ذخیره نشد: ' + e.message }); }
      return {};
    }
    case 'fail':
      dropRules(jobRules.get(msg.id)); jobRules.delete(msg.id);
      setJob(msg.id, { state: 'error', text: msg.error });
      scheduleClose();
      return {};
    default:
      return {};
  }
}
