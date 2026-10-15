// Sobtechno Video Downloader — popup
// Author: Sobtechno

const $ = (s) => document.querySelector(s);
const send = (m) => chrome.runtime.sendMessage(m);
const fa = (n) => Number(n).toLocaleString('fa-IR');

const ICONS = {
  download: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
  record: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/></svg>',
};

const el = (tag, cls, ...kids) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const icon = (name) => { const s = document.createElement('span'); s.innerHTML = ICONS[name]; return s.firstChild; };

let tabId = null;
let items = [];
let jobs = {};
let enabled = true;
let unsupported = false;
const selected = {}; // item id -> chosen variant url

/* ---------- formatting ---------- */
const fmtSize = (b) => {
  if (!b) return '';
  const mb = b / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb >= 1 ? mb.toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
};
const fmtDur = (s) => {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(x)}` : `${m}:${p(x)}`;
};
const kindLabel = (i) => ({ file: (i.ext || 'file').toUpperCase(), hls: 'HLS', dash: 'DASH', record: 'ضبط' }[i.kind]);

/* ---------- render ---------- */
function render() {
  const power = $('#power');
  power.setAttribute('aria-checked', String(enabled));

  const status = $('#status');
  const list = $('#list');
  if (unsupported) status.textContent = 'این صفحه پشتیبانی نمی‌شود';
  else if (!enabled) status.textContent = 'اسکن خاموش است';
  else status.textContent = items.length ? `${fa(items.length)} مورد در این صفحه` : 'در حال جست‌وجو';

  if (unsupported || !items.length) {
    list.replaceChildren(
      el('div', 'empty',
        el('h2', '', unsupported ? 'اینجا کار نمی‌کند' : 'هنوز ویدیویی پیدا نشد'),
        el('p', '', unsupported
          ? 'افزونه فقط روی صفحه‌های http و https فعال است.'
          : 'ویدیو را پخش کن تا شناسایی شود. بعضی سایت‌ها لینک را فقط بعد از شروع پخش نشان می‌دهند.'))
    );
    return;
  }
  list.replaceChildren(...items.map(row));
}

function row(i) {
  const job = jobs[i.id];
  const running = job?.state === 'run';

  const thumb = el('div', 'thumb');
  if (i.poster) {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    img.src = i.poster;
    img.onerror = () => img.replaceWith(el('span', 'kind', kindLabel(i)));
    thumb.append(img);
  } else thumb.append(el('span', 'kind', kindLabel(i)));
  if (i.duration) thumb.append(el('span', 'dur', fmtDur(i.duration)));

  const meta = el('div', 'meta',
    el('span', 'tag', kindLabel(i)),
    i.h ? `${i.h}p` : null,
    fmtSize(i.size) || null,
    i.audioSeparate ? 'صدا جداست' : null);

  const info = el('div', 'info', el('div', 'title', i.title), meta);
  info.querySelector('.title').title = i.title;

  if (i.kind === 'hls' && i.variants?.length > 1) {
    const sel = el('select');
    i.variants.forEach((v, n) => {
      const o = el('option', '', v.height ? `${v.height}p` : `${Math.round(v.bandwidth / 1000)}k`);
      o.value = v.url;
      if ((selected[i.id] || i.variants[0].url) === v.url) o.selected = true;
      sel.append(o);
    });
    sel.addEventListener('change', () => { selected[i.id] = sel.value; });
    sel.disabled = running;
    info.append(sel);
  }

  let note = null;
  if (i.kind === 'dash') note = el('div', 'note', 'DASH مستقیم دانلود نمی‌شود؛ از ردیف «ضبط» استفاده کن.');
  else if (i.live) note = el('div', 'note', 'پخش زنده پشتیبانی نمی‌شود.');
  else if (i.drm) note = el('div', 'note err', 'محافظت‌شده با DRM؛ قابل دانلود نیست.');
  const jobMsg = el('div', 'note job-msg');
  if (job) {
    jobMsg.textContent = job.text || '';
    if (job.state === 'error') jobMsg.classList.add('err');
  }
  info.append(...[note, jobMsg].filter(Boolean));

  const actions = el('div', 'actions');
  if (running && i.kind === 'hls') {
    const cancel = el('button', 'btn small');
    cancel.append(icon('close'));
    cancel.title = 'لغو';
    cancel.setAttribute('aria-label', 'لغو');
    cancel.addEventListener('click', () => send({ action: 'cancel', id: i.id }));
    actions.append(cancel);
  }
  actions.append(actionButton(i, running));

  const bar = el('div', 'bar', el('i'));
  bar.firstChild.style.width = (running ? job.pct || 0 : 0) + '%';

  const r = el('div', 'item', thumb, info, actions, bar);
  r.dataset.id = i.id;
  return r;
}

function actionButton(i, running) {
  const b = el('button', 'btn');
  if (i.kind === 'record') {
    b.classList.add(i.recording ? 'rec' : 'ghost');
    b.append(icon(i.recording ? 'stop' : 'record'));
    b.title = i.recording ? 'توقف و ذخیره' : 'ضبط ویدیو';
    b.addEventListener('click', async () => {
      const r = await send({ action: i.recording ? 'recStop' : 'recStart', tabId, id: i.id });
      if (r?.error) alert(r.error);
    });
  } else {
    b.append(icon('download'));
    b.title = 'دانلود';
    b.disabled = running || i.kind === 'dash' || !!i.live || !!i.drm;
    b.addEventListener('click', async () => {
      const r = await send({ action: 'download', tabId, id: i.id, variantUrl: selected[i.id] });
      if (r?.error) alert(r.error);
    });
  }
  b.setAttribute('aria-label', b.title);
  return b;
}

/* ---------- data ---------- */
async function refresh() {
  const r = await send({ action: 'list', tabId });
  if (r && !r.error) { items = r.items; enabled = r.enabled; jobs = r.jobs || {}; }
  render();
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.action === 'update' && m.tabId === tabId) refresh();
  else if (m.action === 'job') {
    jobs[m.id] = m.job;
    const r = document.querySelector(`.item[data-id="${m.id}"]`);
    if (r && m.job.state === 'run') {
      r.querySelector('.bar i').style.width = (m.job.pct || 0) + '%';
      r.querySelector('.job-msg').textContent = m.job.text || '';
    } else render();
  }
});

/* ---------- UI events ---------- */
$('#power').addEventListener('click', async () => {
  enabled = !enabled;
  render();
  await send({ action: 'setEnabled', value: enabled });
});

const menu = $('#menu');
$('#menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  $('#menuBtn').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', () => { menu.hidden = true; });

$('#clearBtn').addEventListener('click', async () => { await send({ action: 'clear', tabId }); items = []; render(); });

function sheet(title, html) {
  $('#sheetTitle').textContent = title;
  $('#sheetText').innerHTML = html; // static trusted strings only
  $('#sheet').hidden = false;
}
$('#sheetClose').addEventListener('click', () => { $('#sheet').hidden = true; });

$('#helpBtn').addEventListener('click', () => sheet('راهنما', `
  <ol>
    <li>ویدیو را در صفحه پخش کن تا شناسایی شود.</li>
    <li>روی دکمه دانلود کنار هر مورد بزن. برای HLS می‌توانی کیفیت را انتخاب کنی.</li>
    <li>اگر لینکی نبود (پلیرهای blob)، «ضبط» را بزن. ویدیو هنگام پخش ضبط می‌شود و بعد از توقف به‌صورت WebM ذخیره می‌شود. صدای ویدیو نباید بی‌صدا شده باشد.</li>
  </ol>
  <p>محتوای محافظت‌شده با DRM (مثل Netflix) پشتیبانی نمی‌شود. فقط محتوایی را دانلود کن که اجازه‌اش را داری.</p>`));

$('#aboutBtn').addEventListener('click', () => sheet('درباره', `
  <p>Sobtechno Video Downloader نسخه 4.0.0</p>
  <p>ساخته‌شده توسط Sobtechno. متن‌باز با مجوز MIT.</p>
  <p>همه کارها داخل مرورگر انجام می‌شود و هیچ داده‌ای به سروری ارسال نمی‌شود.</p>
  <p><a href="https://github.com/Sobtechno" target="_blank" rel="noopener">github.com/Sobtechno</a></p>`));

/* ---------- init ---------- */
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  unsupported = !/^https?:/.test(tab?.url || '');
  await refresh();
})();
