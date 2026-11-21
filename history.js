/* Motion history page: scroll back through saved motion pop-ups. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const KINDS = {
  vehicle: ['Car', 'Truck', 'Bus', 'Motorcycle', 'Bicycle'],
  animal: ['Dog', 'Cat', 'Horse', 'Animal'],
};
const session = (() => { try { return JSON.parse(localStorage.getItem('cv.session')); } catch { return null; } })();

let oldest = Infinity;        // time of the oldest event shown so far
let loading = false, finished = false;
let shown = [];               // events in display order (newest first)
const urls = new Map();       // event id -> object URL
let viewing = -1;             // index into `shown` open in the viewer
let hls = null;
let unseen = 0;

function matches(ev) {
  const cam = $('#fCam').value, kind = $('#fKind').value;
  if (cam && ev.cam !== cam) return false;
  if (!kind) return true;
  const labels = ev.label.split(', ');
  if (kind === 'Person') return labels.includes('Person');
  return labels.some(l => KINDS[kind].includes(l));
}

function urlFor(ev) {
  if (!urls.has(ev.id)) urls.set(ev.id, URL.createObjectURL(ev.img));
  return urls.get(ev.id);
}

function dayLabel(t) {
  const d = new Date(t), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function card(ev, isNew) {
  const el = document.createElement('div');
  el.className = 'h-card' + (ev.key ? ' key' : '') + (isNew ? ' new' : '');
  el.innerHTML = `<img alt="" loading="lazy"><div class="h-meta"><span class="h-cam"></span><span class="h-label"></span><span class="h-time"></span></div>`;
  $('img', el).src = urlFor(ev);
  $('.h-cam', el).textContent = (ev.key ? '★ ' : '') + ev.name;
  $('.h-label', el).textContent = ev.label;
  $('.h-time', el).textContent = new Date(ev.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  el.onclick = () => openViewer(shown.indexOf(ev));
  return el;
}

function sectionFor(t, atTop) {
  const label = dayLabel(t);
  const list = $('#list');
  const sections = [...list.querySelectorAll('.h-section')];
  let sec = sections.find(s => s.dataset.day === label);
  if (!sec) {
    sec = document.createElement('section');
    sec.className = 'h-section'; sec.dataset.day = label;
    sec.innerHTML = `<h3 class="h-day"></h3><div class="h-grid"></div>`;
    $('.h-day', sec).textContent = label;
    if (atTop) list.prepend(sec); else list.appendChild(sec);
  }
  return $('.h-grid', sec);
}

async function loadMore() {
  if (loading || finished) return;
  loading = true;
  $('#more').textContent = 'Loading…';
  try {
    const evs = await HistoryDB.page({ before: oldest, limit: 60, filter: matches });
    for (const ev of evs) {
      shown.push(ev);
      sectionFor(ev.t, false).appendChild(card(ev));
      oldest = ev.t;
    }
    if (evs.length < 60) finished = true;
  } catch (e) {
    console.error(e);
    $('#more').textContent = 'Could not read the saved motion: ' + e.message;
    loading = false; return;
  }
  loading = false;
  if (!shown.length) {
    $('#list').innerHTML = `<div class="h-empty">No motion saved yet.<br>Pop-ups from the camera page are saved here on this device for 14 days.<br>Keep the camera page open in another tab.</div>`;
  }
  $('#more').textContent = finished ? (shown.length ? 'That’s everything from the last 14 days.' : '') : '';
}

function reload() {
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
  shown = []; oldest = Infinity; finished = false;
  $('#list').textContent = '';
  loadMore();
}

async function onAdded(id) {
  const ev = await HistoryDB.get(id);
  if (!ev || !matches(ev)) return;
  if (!shown.length) $('#list').textContent = '';
  shown.unshift(ev);
  if (viewing >= 0) viewing++;
  const grid = sectionFor(ev.t, true);
  grid.prepend(card(ev, true));
  if (document.hidden) { unseen++; document.title = `(${unseen}) Motion History`; }
}

/* ---------- Viewer ---------- */

function openViewer(i) {
  if (i < 0 || i >= shown.length) return;
  stopVideo();
  viewing = i;
  const ev = shown[i];
  $('#viewerModal').hidden = false;
  $('#vImg').hidden = false;
  $('#vImg').src = urlFor(ev);
  const when = new Date(ev.t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  $('#vTitle').textContent = `${ev.key ? '★ ' : ''}${ev.name} · ${ev.label} · ${when}`;
  $('#vMsg').textContent = '';
  $('#vPrev').disabled = i === 0;
  $('#vNext').disabled = i === shown.length - 1 && finished;
}

function stopVideo() {
  if (hls) { hls.destroy(); hls = null; }
  const v = $('#vVideo');
  v.pause(); v.removeAttribute('src'); v.load(); v.hidden = true;
}

function closeViewer() { stopVideo(); $('#viewerModal').hidden = true; viewing = -1; }

async function step(d) {
  let i = viewing + d;
  if (i >= shown.length && !finished) { await loadMore(); }
  if (i >= 0 && i < shown.length) openViewer(i);
}

function playRecording() {
  const ev = shown[viewing];
  if (!ev) return;
  if (!session?.token) { $('#vMsg').textContent = 'Sign in on the camera page first.'; return; }
  if (!(window.Hls && Hls.isSupported())) { $('#vMsg').textContent = 'This browser can’t play recordings here.'; return; }
  stopVideo();
  const v = $('#vVideo');
  const url = `${session.base}/hls/${ev.cam}.m3u8?hi&pos=${ev.t - 5000}`;
  hls = new Hls({ xhrSetup: x => x.setRequestHeader('Authorization', 'Bearer ' + session.token), backBufferLength: 30 });
  hls.on(Hls.Events.MANIFEST_PARSED, () => { $('#vImg').hidden = true; v.hidden = false; v.play().catch(() => {}); $('#vMsg').textContent = 'Playing the recording from 5 seconds before the pop-up.'; });
  hls.on(Hls.Events.ERROR, (_, data) => {
    if (!data.fatal) return;
    stopVideo(); $('#vImg').hidden = false;
    $('#vMsg').textContent = data.response && data.response.code === 401
      ? 'Your sign-in expired. Sign in again on the camera page.'
      : 'Couldn’t play the recording for this moment.';
  });
  $('#vMsg').textContent = 'Loading the recording…';
  hls.loadSource(url);
  hls.attachMedia(v);
}

/* ---------- Wiring ---------- */

function fillCams() {
  let cfg = {}, names = new Map();
  try { cfg = JSON.parse(localStorage.getItem('cv.config')) || {}; } catch {}
  // Cameras that appear in the saved history, plus starred ones.
  HistoryDB.page({ limit: 2000 }).then(evs => {
    for (const ev of evs) if (!names.has(ev.cam)) names.set(ev.cam, ev.name);
    for (const id of Object.keys(cfg.key || {})) if (!names.has(id)) names.set(id, (cfg.names || {})[id] || id);
    const sel = $('#fCam');
    for (const [id, name] of [...names].sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }))) {
      const o = document.createElement('option'); o.value = id; o.textContent = name; sel.appendChild(o);
    }
  }).catch(() => {});
}

let lastAlive = 0;
HistoryDB.channel?.addEventListener('message', e => {
  if (e.data.type === 'added') onAdded(e.data.id);
  if (e.data.type === 'cleared') reload();
  if (e.data.type === 'alive') lastAlive = Date.now();
  if (e.data.type === 'focus' && e.data.id) { /* the camera page asked to show an event */ }
});
setInterval(() => {
  const on = Date.now() - lastAlive < 25000;
  const dot = $('#liveDot');
  dot.classList.toggle('on', on);
  dot.title = on ? 'Live: new motion appears here as it happens' : 'Not live: open the camera page in another tab to record motion';
}, 2000);

document.addEventListener('visibilitychange', () => { if (!document.hidden) { unseen = 0; document.title = 'Motion History · Shop Cameras'; } });
$('#fCam').onchange = reload;
$('#fKind').onchange = reload;
let clearArmed = null;
$('#btnClear').onclick = async () => {
  const b = $('#btnClear');
  if (!clearArmed) {
    b.textContent = 'Tap again to delete all';
    clearArmed = setTimeout(() => { clearArmed = null; b.textContent = 'Clear'; }, 4000);
    return;
  }
  clearTimeout(clearArmed); clearArmed = null; b.textContent = 'Clear';
  await HistoryDB.clear();
};
$('#vClose').onclick = closeViewer;
$('#vPrev').onclick = () => step(-1);
$('#vNext').onclick = () => step(1);
$('#vPlay').onclick = playRecording;
document.addEventListener('keydown', e => {
  if ($('#viewerModal').hidden) return;
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
});
new IntersectionObserver(es => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: '600px' }).observe($('#more'));

fillCams();
loadMore();
