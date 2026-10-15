// Offscreen worker: downloads HLS segments, decrypts AES-128, merges into one Blob.
// Author: Sobtechno
import { fetchText, isMaster, parseMaster, parseMedia } from './hls.js';

const CONCURRENCY = 6;
const jobs = new Map(); // id -> AbortController
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (m) => chrome.runtime.sendMessage({ from: 'offscreen', ...m }).catch(() => {});

chrome.runtime.onMessage.addListener((m) => {
  if (m.target !== 'offscreen') return;
  if (m.action === 'hls') runHls(m);
  else if (m.action === 'cancel') jobs.get(m.id)?.abort();
  else if (m.action === 'revoke') URL.revokeObjectURL(m.url);
});

async function getBuf(url, range, signal) {
  for (let t = 0; ; t++) {
    try {
      const headers = range ? { Range: `bytes=${range[0]}-${range[1]}` } : {};
      const r = await fetch(url, { credentials: 'include', signal, headers });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.arrayBuffer();
    } catch (e) {
      if (signal.aborted || t >= 2) throw e;
      await sleep(600 * (t + 1));
    }
  }
}

const keyCache = new Map();
function getKey(uri, signal) {
  if (!keyCache.has(uri)) {
    keyCache.set(uri, getBuf(uri, null, signal).then((b) => crypto.subtle.importKey('raw', b, 'AES-CBC', false, ['decrypt'])));
  }
  return keyCache.get(uri);
}

function ivOf(key, seq) {
  if (key.iv) {
    const hex = key.iv.replace(/^0x/i, '').padStart(32, '0');
    return Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));
  }
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, seq);
  return iv;
}

async function getSegment(seg, signal) {
  const buf = await getBuf(seg.url, seg.range, signal);
  if (!seg.key) return buf;
  const k = await getKey(seg.key.uri, signal);
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivOf(seg.key, seg.seq) }, k, buf);
}

async function runHls({ id, url, variantUrl, name }) {
  const ctl = new AbortController();
  jobs.set(id, ctl);
  try {
    let mediaUrl = url;
    let text = await fetchText(url, ctl.signal);
    if (isMaster(text)) {
      const { variants } = parseMaster(text, url);
      mediaUrl = variantUrl || variants[0]?.url;
      if (!mediaUrl) throw new Error('کیفیتی در پلی‌لیست پیدا نشد');
      text = await fetchText(mediaUrl, ctl.signal);
    }
    const pl = parseMedia(text, mediaUrl);
    if (pl.drm) throw new Error('این استریم رمزگذاری DRM دارد و قابل دانلود نیست');
    if (pl.live) throw new Error('پخش زنده پشتیبانی نمی‌شود');
    if (!pl.segs.length) throw new Error('هیچ بخشی در پلی‌لیست نبود');

    const parts = new Array(pl.segs.length);
    const initBuf = pl.map ? await getBuf(pl.map.url, pl.map.range, ctl.signal) : null;
    let next = 0, done = 0, lastPost = 0;

    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= pl.segs.length) return;
        parts[i] = await getSegment(pl.segs[i], ctl.signal);
        done++;
        const now = Date.now();
        if (now - lastPost > 300 || done === pl.segs.length) {
          lastPost = now;
          post({ action: 'progress', id, pct: Math.round((done / pl.segs.length) * 100), text: `${done} از ${pl.segs.length} بخش` });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pl.segs.length) }, worker).map((p) => p.catch((e) => { ctl.abort(); throw e; })));

    const fmp4 = !!pl.map || /\.(m4s|mp4|m4v)(\?|$)/i.test(pl.segs[0].url);
    const blob = new Blob(initBuf ? [initBuf, ...parts] : parts, { type: fmp4 ? 'video/mp4' : 'video/mp2t' });
    post({ action: 'done', id, blobUrl: URL.createObjectURL(blob), ext: fmp4 ? 'mp4' : 'ts', name });
  } catch (e) {
    post({ action: 'fail', id, error: ctl.signal.aborted && !e.message.startsWith('HTTP') ? 'لغو شد' : String(e.message || e) });
  } finally {
    jobs.delete(id);
  }
}
