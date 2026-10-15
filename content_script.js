// Sobtechno Video Downloader — content script
// Finds <video> elements (incl. Shadow DOM) and offers a recording fallback for blob/MSE players.
// Author: Sobtechno
(() => {
  if (window.__sobtechnoVD) return;
  window.__sobtechnoVD = true;

  const videos = new Map();
  let seq = 0, last = '', timer = 0, rec = null;

  const collect = (root, out) => {
    root.querySelectorAll('video').forEach((v) => out.add(v));
    root.querySelectorAll('*').forEach((h) => { if (h.shadowRoot) collect(h.shadowRoot, out); });
  };

  const titleOf = (v) =>
    v.getAttribute('title') || v.getAttribute('aria-label') || v.getAttribute('data-title') || document.title || '';

  function scan() {
    const set = new Set();
    collect(document, set);
    const list = [];
    for (const v of set) {
      if (!v.__vdId) {
        v.__vdId = ++seq;
        videos.set(v.__vdId, v);
        v.addEventListener('loadedmetadata', schedule, { passive: true });
        v.addEventListener('play', schedule, { passive: true });
      }
      const src = v.currentSrc || v.src || v.querySelector('source')?.src || '';
      if (!src) continue;
      list.push({
        vid: v.__vdId,
        src,
        poster: v.poster || '',
        duration: Number.isFinite(v.duration) ? Math.round(v.duration) : 0,
        h: v.videoHeight || 0,
        title: titleOf(v),
      });
    }
    const json = JSON.stringify(list);
    if (json === last) return;
    last = json;
    try { chrome.runtime.sendMessage({ action: 'domVideos', videos: list }).catch(() => {}); } catch { /* context invalidated */ }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(scan, 600);
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => { if (!document.hidden) schedule(); }, 5000);
  schedule();

  /* ---------- recording fallback ---------- */
  const pickMime = () =>
    ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';

  function report(vid, recording) {
    try { chrome.runtime.sendMessage({ action: 'recState', vid, recording }).catch(() => {}); } catch { /* ignore */ }
  }

  function save(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name || 'video'}.webm`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function stopRec() {
    if (rec && rec.mr.state !== 'inactive') rec.mr.stop();
  }

  function startRec(vid, title) {
    if (rec) return { error: 'یک ضبط دیگر در حال انجام است' };
    const v = videos.get(vid);
    if (!v) return { error: 'ویدیو در صفحه پیدا نشد' };
    const cap = v.captureStream || v.mozCaptureStream;
    if (!cap) return { error: 'مرورگر از ضبط این ویدیو پشتیبانی نمی‌کند' };
    let stream;
    try { stream = cap.call(v); } catch { return { error: 'ضبط این ویدیو ممکن نیست' }; }

    const chunks = [];
    const mr = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: 6e6 });
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      v.removeEventListener('ended', stopRec);
      if (chunks.length) save(new Blob(chunks, { type: 'video/webm' }), title);
      rec = null;
      report(vid, false);
    };
    rec = { mr, vid };
    v.addEventListener('ended', stopRec);
    mr.start(1000);
    if (v.paused) v.play().catch(() => {});
    report(vid, true);
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg.action === 'recStart') send(startRec(msg.vid, msg.title));
    else if (msg.action === 'recStop') { stopRec(); send({ ok: true }); }
  });
})();
