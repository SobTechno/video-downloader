// Shared HLS (m3u8) helpers — used by background.js (probing) and offscreen.js (downloading)
// Author: Sobtechno

export const abs = (u, base) => new URL(u, base).href;

export async function fetchText(url, signal) {
  const r = await fetch(url, { credentials: 'include', signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

const attrs = (s) => {
  const o = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) o[m[1]] = m[2].replace(/^"|"$/g, '');
  return o;
};
const lines = (t) => t.split(/\r?\n/).map((s) => s.trim());
const after = (l) => l.slice(l.indexOf(':') + 1);

export const isMaster = (t) => t.includes('#EXT-X-STREAM-INF');

/** Master playlist -> variants sorted best first */
export function parseMaster(text, base) {
  const L = lines(text);
  const variants = [];
  let audioSeparate = false;
  for (let i = 0; i < L.length; i++) {
    if (L[i].startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(L[i]) && /URI=/.test(L[i])) audioSeparate = true;
    if (!L[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = attrs(after(L[i]));
    let j = i + 1;
    while (j < L.length && (!L[j] || L[j].startsWith('#'))) j++;
    if (!L[j]) continue;
    variants.push({
      url: abs(L[j], base),
      bandwidth: +a.BANDWIDTH || 0,
      height: +(a.RESOLUTION || '').split('x')[1] || 0,
      audioGroup: !!a.AUDIO,
    });
  }
  variants.sort((x, y) => y.height - x.height || y.bandwidth - x.bandwidth);
  return { variants, audioSeparate: audioSeparate && variants.some((v) => v.audioGroup) };
}

/** Media playlist -> segments (+ init map, encryption info) */
export function parseMedia(text, base) {
  let seq = 0, key = null, map = null, dur = 0, d = 0, range = null, lastEnd = 0, ended = false, drm = '';
  const segs = [];
  for (const l of lines(text)) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = +after(l) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = attrs(after(l));
      if (a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128') key = { uri: abs(a.URI, base), iv: a.IV || null };
      else { key = { unsupported: true }; drm = a.METHOD || 'DRM'; }
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = attrs(after(l));
      map = { url: abs(a.URI, base), range: a.BYTERANGE ? toRange(a.BYTERANGE, 0) : null };
    } else if (l.startsWith('#EXTINF:')) d = parseFloat(after(l)) || 0;
    else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      range = toRange(after(l), lastEnd);
      lastEnd = range[1] + 1;
    } else if (l === '#EXT-X-ENDLIST') ended = true;
    else if (l && !l.startsWith('#')) {
      segs.push({ url: abs(l, base), key, seq: seq + segs.length, range });
      dur += d; d = 0; range = null;
    }
  }
  return { segs, map, duration: dur, live: !ended, drm };
}

function toRange(str, fallbackStart) {
  const [n, o] = str.split('@');
  const start = o !== undefined ? +o : fallbackStart;
  return [start, start + +n - 1];
}
