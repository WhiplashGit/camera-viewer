/* Motion pop-ups for Shop Cameras.
 *
 * Every few seconds each watched camera's small snapshot is compared with the
 * previous one. Only cameras whose picture changed are checked by an object
 * detector (COCO-SSD, running in the browser). A pop-up appears only when a
 * person, vehicle or animal is found AND that object sits where the picture
 * changed, so a parked car next to blowing leaves does not trigger.
 *
 * Nothing here changes anything on the camera server.
 * Uses globals from app.js: cfg, cams, session, api, fetchSnapshot, displayName,
 * visibleCams, openSingle, closeSingle, single, handleError, saveConfig, $, $$. */
'use strict';

const MOTION_DEFAULTS = { enabled: true, sensitivity: 'normal', sound: true, intervalS: 3 };
const TARGETS = {
  person: 'Person', bicycle: 'Bicycle', motorcycle: 'Motorcycle', car: 'Car', truck: 'Truck',
  bus: 'Bus', dog: 'Dog', cat: 'Cat', horse: 'Horse', cow: 'Animal', sheep: 'Animal', bear: 'Animal',
};
const SENS = {               // fraction of the picture that must change, detector min score
  high: { change: 0.002, score: 0.40 },
  normal: { change: 0.005, score: 0.50 },
  low: { change: 0.012, score: 0.60 },
};
const DIFF_W = 64, DIFF_H = 36;           // motion grid
const PIXEL_DELTA = 28;                   // grey-level change that counts as "changed"
const POPUP_HOLD_MS = 25000;              // keep a pop-up this long after the last detection
const COOLDOWN_MS = 8000;
const MAX_DETECT_PER_PASS = 4;           // AI checks per pass, most "new" movement first
const NOISE_ALPHA = 0.04;                 // how fast a cell learns it is noisy (~25 passes)
const NOISY = 0.35;                       // cells changing this often are treated as background
const LOG_MAX = 40;                 // don't re-alert the same camera faster than this
const KEY_HOLD_MS = 30000;                // full-screen alert length for key cameras
const maxPopups = () => (Math.min(window.innerWidth, window.innerHeight) < 600 ? 2 : 4);

let motionModel = null;
let motionLoading = null;
let motionGen = 0;
const camState = new Map();               // id -> {grey, lastAlert}
const popups = new Map();                 // id -> {el, canvas, timer}
let keyAlert = null;                      // {id, until, prev}
let audioCtx = null;

function mcfg() {
  cfg.motion = Object.assign({}, MOTION_DEFAULTS, cfg.motion || {});
  cfg.noMotion = cfg.noMotion || {};
  return cfg.motion;
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

async function loadModel() {
  if (motionModel) return motionModel;
  if (!motionLoading) {
    motionLoading = (async () => {
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
      try { await tf.setBackend('webgl'); } catch {}
      try { tf.env().set('WEBGL_DELETE_TEXTURE_THRESHOLD', 0); } catch {}
      await tf.ready();
      motionModel = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
      return motionModel;
    })().catch(e => { motionLoading = null; throw e; });
  }
  return motionLoading;
}

function watchedCams() {
  mcfg();
  return visibleCams().filter(id => !cfg.noMotion[id]);
}

/* ---------- Monitor loop ---------- */

async function startMotion() {
  stopMotion();
  const m = mcfg();
  updateMotionButton();
  if (!m.enabled || !session) return;
  const gen = ++motionGen;
  setMotionStatus('loading');
  try { await loadModel(); }
  catch (e) { console.error(e); setMotionStatus('error'); return; }
  if (gen !== motionGen) return;
  setMotionStatus('on');
  while (gen === motionGen && session) {
    const started = Date.now();
    if (!document.hidden) {
      // Pass 1 (cheap): small snapshot of every camera, compared with the last one.
      const ids = watchedCams();
      const candidates = [];
      let next = 0;
      const worker = async () => {
        while (next < ids.length && gen === motionGen) {
          const id = ids[next++];
          try { const c = await diffCamera(id); if (c) candidates.push(c); }
          catch (e) { if (handleError(e)) { motionGen++; return; } }
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));

      // Pass 2 (expensive): run the AI on only the few cameras that changed most.
      // Cameras that keep changing with nothing found (trees in wind, rain,
      // night noise) are only re-checked every so often.
      const now = Date.now();
      // Cameras that just had a hit, or haven't had an AI check in a while, go first.
      for (const c of candidates) {
        const st = camState.get(c.id);
        if (st.lastHit && now - st.lastHit < 15000) c.score += 1;
        if (!st.lastDetect || now - st.lastDetect > 10000) c.score += 0.5;
      }
      candidates.sort((a, b) => b.score - a.score);
      const picked = candidates.slice(0, MAX_DETECT_PER_PASS);
      for (const c of candidates.slice(MAX_DETECT_PER_PASS)) logEvent(c.id, 'Movement, waiting for a free AI check');
      for (const c of picked) {
        if (gen !== motionGen) break;
        try { await detectCamera(c); }
        catch (e) { if (handleError(e)) { motionGen++; break; } console.error(e); }
      }
      updateMotionStats();
    }
    const wait = mcfg().intervalS * 1000 - (Date.now() - started);
    await new Promise(r => setTimeout(r, Math.max(300, wait)));
  }
}

function stopMotion() {
  motionGen++;
  setMotionStatus(mcfg().enabled ? 'idle' : 'off');
}

let greyCanvas;
function greyOf(bitmap) {
  greyCanvas = greyCanvas || Object.assign(document.createElement('canvas'), { width: DIFF_W, height: DIFF_H });
  const ctx = greyCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, DIFF_W, DIFF_H);
  const d = ctx.getImageData(0, 0, DIFF_W, DIFF_H).data;
  const g = new Uint8Array(DIFF_W * DIFF_H);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return g;
}

async function snapBitmap(id, w, h) {
  const r = await api(`/rest/v2/devices/${id}/image?size=${w}x${h}&format=jpg`, { raw: true });
  return createImageBitmap(await r.blob());
}

/* Returns {id, changed, score} when enough of the picture changed, else null. */
async function diffCamera(id) {
  const st = camState.get(id) || {};
  camState.set(id, st);
  const small = await snapBitmap(id, 320, 180);
  stat('snaps');
  const grey = greyOf(small);
  small.close?.();
  const prev = st.grey;
  st.grey = grey;
  if (!prev) return null;

  const raw = new Uint8Array(grey.length);
  for (let i = 0; i < grey.length; i++) if (Math.abs(grey[i] - prev[i]) > PIXEL_DELTA) raw[i] = 1;
  // Ignore speckle: a changed cell only counts if at least 2 neighbours changed too.
  const changed = new Uint8Array(grey.length);
  let n = 0;
  for (let y = 0; y < DIFF_H; y++) for (let x = 0; x < DIFF_W; x++) {
    const i = y * DIFF_W + x;
    if (!raw[i]) continue;
    let nb = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < DIFF_W && yy < DIFF_H) nb += raw[yy * DIFF_W + xx];
    }
    if (nb >= 2) { changed[i] = 1; n++; }
  }
  const frac = n / grey.length;
  if (frac > 0.6) return null;                    // whole-picture lighting change (clouds, IR switching)

  // Learn which cells are always moving, and count only movement in normally still areas.
  st.noise = st.noise || new Float32Array(grey.length);
  let novel = 0;
  for (let i = 0; i < grey.length; i++) {
    if (changed[i] && st.noise[i] < NOISY) novel++;
    st.noise[i] += NOISE_ALPHA * (changed[i] - st.noise[i]);
  }
  const sens = SENS[mcfg().sensitivity] || SENS.normal;
  const score = novel / grey.length;
  if (score < sens.change) return null;
  return { id, changed, score };
}

async function detectCamera({ id, changed }) {
  const st = camState.get(id);
  st.lastDetect = Date.now();
  const sens = SENS[mcfg().sensitivity] || SENS.normal;
  const big = await snapBitmap(id, 640, 360);
  let dets;
  const t0 = performance.now();
  try { dets = await motionModel.detect(big, 10, sens.score); }
  catch (e) { big.close?.(); throw e; }
  stat('dets', performance.now() - t0);

  const hits = [];
  for (const d of dets) {
    const label = TARGETS[d.class];
    if (!label) continue;
    const [x, y, w, h] = d.bbox;
    // Count changed motion-grid cells inside the box. The server may keep the
    // camera's own aspect ratio, so scale by the real image size.
    const sx = big.width / DIFF_W, sy = big.height / DIFF_H;
    const x0 = Math.max(0, Math.floor(x / sx)), x1 = Math.min(DIFF_W - 1, Math.floor((x + w) / sx));
    const y0 = Math.max(0, Math.floor(y / sy)), y1 = Math.min(DIFF_H - 1, Math.floor((y + h) / sy));
    let inside = 0;
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) inside += changed[yy * DIFF_W + xx];
    if (inside >= 2) hits.push({ label, score: d.score, bbox: d.bbox });
  }
  if (!hits.length) {
    big.close?.();
    const seen = [...new Set(dets.map(d => TARGETS[d.class]).filter(Boolean))];
    logEvent(id, seen.length ? `AI saw ${seen.join(', ')}, but it wasn't moving` : 'Movement checked, no person, vehicle or animal');
    return;
  }
  st.lastHit = Date.now();
  logEvent(id, 'Pop-up: ' + [...new Set(hits.map(h => h.label))].join(', '), true);
  onDetection(id, hits, big);
}

/* ---------- Activity log ---------- */

const activity = [];
function logEvent(id, text, hit) {
  const last = activity[0];
  if (last && last.id === id && last.text === text && Date.now() - last.t < 20000) { last.t = Date.now(); last.n++; }
  else activity.unshift({ t: Date.now(), id, text, hit: !!hit, n: 1 });
  if (activity.length > LOG_MAX) activity.length = LOG_MAX;
  renderActivity();
}

function renderActivity() {
  const box = $('#motionLog');
  if (!box || $('#setup').hidden) return;
  box.textContent = '';
  if (!activity.length) { box.textContent = 'Nothing yet. Movement and AI checks will be listed here.'; return; }
  for (const a of activity) {
    const row = document.createElement('div');
    row.className = 'log-row' + (a.hit ? ' hit' : '');
    const time = new Date(a.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    row.textContent = `${time} · ${displayName(a.id)} · ${a.text}` + (a.n > 1 ? ` (×${a.n})` : '');
    box.appendChild(row);
  }
}

/* ---------- Usage stats (last 60 seconds) ---------- */

const stats = { snaps: [], dets: [] };
function stat(kind, ms) {
  const now = Date.now();
  stats[kind].push([now, ms || 0]);
  while (stats[kind].length && now - stats[kind][0][0] > 60000) stats[kind].shift();
}

function motionStatsText() {
  const now = Date.now();
  const recent = k => stats[k].filter(e => now - e[0] <= 60000);
  const s = recent('snaps'), d = recent('dets');
  const avg = d.length ? Math.round(d.reduce((a, e) => a + e[1], 0) / d.length) : 0;
  return `Last minute: ${s.length} snapshots compared, ${d.length} AI checks` + (d.length ? ` (about ${avg} ms each)` : '') + '.';
}

function updateMotionStats() {
  const el = $('#motionStats');
  if (el) el.textContent = mcfg().enabled ? motionStatsText() : 'Motion pop-ups are paused.';
  renderActivity();
  const b = $('#btnMotion');
  if (b && b.dataset.state === 'on') b.title = `Watching ${watchedCams().length} cameras. ${motionStatsText()} Click to pause.`;
}

/* ---------- Alerts ---------- */

function onDetection(id, hits, bitmap) {
  const now = Date.now();
  const st = camState.get(id);
  const label = [...new Set(hits.map(h => h.label))].join(', ');
  const fresh = !st.lastAlert || now - st.lastAlert > COOLDOWN_MS;
  st.lastAlert = now;
  markTileMotion(id);
  if (cfg.key[id]) keyCameraAlert(id, label, fresh);
  showPopup(id, label, hits, bitmap);
}

function markTileMotion(id) {
  for (const t of $$(`#grid .tile[data-id="${id}"]`)) {
    t.classList.add('motion');
    clearTimeout(t._motionT);
    t._motionT = setTimeout(() => t.classList.remove('motion'), 10000);
  }
}

function showPopup(id, label, hits, bitmap) {
  const box = $('#popups');
  let p = popups.get(id);
  if (!p) {
    if (popups.size >= maxPopups()) {
      // Drop the oldest pop-up
      const [oldId] = popups.keys();
      dismissPopup(oldId);
    }
    const el = document.createElement('div');
    el.className = 'popup' + (cfg.key[id] ? ' key' : '');
    el.innerHTML = `<canvas width="640" height="360"></canvas>
      <div class="popup-bar"><span class="popup-name"></span><span class="popup-label"></span>
      <span class="spacer"></span><button class="popup-x" title="Dismiss">✕</button></div>`;
    el.onclick = e => {
      if (e.target.closest('.popup-x')) { dismissPopup(id); return; }
      openSingle({ id: 'motion', name: displayName(id), cams: [id] }, 0, { badge: label });
      dismissPopup(id);
    };
    box.prepend(el);
    p = { el, canvas: $('canvas', el) };
    popups.set(id, p);
  }
  $('.popup-name', p.el).textContent = (cfg.key[id] ? '★ ' : '') + displayName(id);
  $('.popup-label', p.el).textContent = label;
  if (p.canvas.width !== bitmap.width || p.canvas.height !== bitmap.height) {
    p.canvas.width = bitmap.width; p.canvas.height = bitmap.height;
  }
  const ctx = p.canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  ctx.lineWidth = 3; ctx.font = 'bold 18px sans-serif';
  for (const h of hits) {
    const [x, y, w, hh] = h.bbox;
    ctx.strokeStyle = '#ffcc00'; ctx.strokeRect(x, y, w, hh);
    ctx.fillStyle = '#ffcc00'; ctx.fillText(h.label, x + 4, Math.max(18, y - 4));
  }
  p.el.classList.remove('flash'); void p.el.offsetWidth; p.el.classList.add('flash');
  clearTimeout(p.timer);
  p.timer = setTimeout(() => dismissPopup(id), POPUP_HOLD_MS);
}

function dismissPopup(id) {
  const p = popups.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  p.el.remove();
  popups.delete(id);
}

function keyCameraAlert(id, label, fresh) {
  const until = Date.now() + KEY_HOLD_MS;
  if (keyAlert && keyAlert.id === id) {
    keyAlert.until = until;
    $('#singleBadge').textContent = '⚠ ' + label;
    return;
  }
  // Remember what was on screen so we can go back to it.
  const prev = keyAlert ? keyAlert.prev : (single ? { group: single.group, index: single.index } : null);
  keyAlert = { id, until, prev };
  openSingle({ id: 'alert', name: displayName(id), cams: [id] }, 0, { badge: '⚠ ' + label });
  $('#single').classList.add('alerting');
  if (fresh && mcfg().sound) beep();
  scheduleKeyAlertEnd();
}

function scheduleKeyAlertEnd() {
  clearTimeout(keyAlert?.timer);
  if (!keyAlert) return;
  keyAlert.timer = setTimeout(() => {
    if (!keyAlert) return;
    if (Date.now() < keyAlert.until) { scheduleKeyAlertEnd(); return; }
    endKeyAlert(true);
  }, Math.max(500, keyAlert.until - Date.now()));
}

function endKeyAlert(restore) {
  if (!keyAlert) return;
  const prev = keyAlert.prev;
  clearTimeout(keyAlert.timer);
  keyAlert = null;
  $('#single').classList.remove('alerting');
  if (!restore) return;
  if (prev) openSingle(prev.group, prev.index);
  else if (cfg.rotating) { const g = activeGroup(); if (g.cams.length) openSingle(g, 0); else closeSingle(); }
  else closeSingle();
}

function isKeyAlertActive() { return !!keyAlert; }

function unlockAudio() {
  if (audioCtx) return;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
}

function beep() {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  const t = audioCtx.currentTime;
  for (let i = 0; i < 3; i++) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t + i * 0.3);
    g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.3 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.3 + 0.2);
    o.connect(g).connect(audioCtx.destination);
    o.start(t + i * 0.3); o.stop(t + i * 0.3 + 0.22);
  }
}

/* ---------- UI ---------- */

function setMotionStatus(state) {
  const b = $('#btnMotion');
  if (!b) return;
  b.dataset.state = state;
  b.classList.toggle('on', state === 'on' || state === 'loading');
  const icon = { on: '◉', loading: '◌', error: '⚠' }[state] || '○';
  b.innerHTML = `${icon}<span class="lbl"> Motion</span>`;
  b.title = {
    on: `Watching ${watchedCams().length} cameras for people, vehicles and animals. Click to pause.`,
    loading: 'Loading the detector…',
    error: 'The motion detector could not load. Click to retry.',
  }[state] || 'Motion pop-ups are off. Click to turn on.';
}

function updateMotionButton() { setMotionStatus(mcfg().enabled ? 'idle' : 'off'); }

function toggleMotion() {
  const m = mcfg();
  const state = $('#btnMotion').dataset.state;
  if (state === 'error') { startMotion(); return; }
  m.enabled = !m.enabled; saveConfig();
  if (m.enabled) startMotion(); else { stopMotion(); for (const id of [...popups.keys()]) dismissPopup(id); }
}

function renderMotionSettings() {
  const m = mcfg();
  $('#optMotionOn').checked = m.enabled;
  $('#optSens').value = m.sensitivity;
  $('#optMotionEvery').value = String(m.intervalS);
  $('#optSound').checked = m.sound;
  updateMotionStats();
}

function wireMotion() {
  $('#btnMotion').onclick = toggleMotion;
  $('#optMotionOn').onchange = e => { mcfg().enabled = e.target.checked; saveConfig(); };
  $('#optSens').onchange = e => { mcfg().sensitivity = e.target.value; saveConfig(); };
  $('#optMotionEvery').onchange = e => { mcfg().intervalS = +e.target.value; saveConfig(); };
  $('#optSound').onchange = e => { mcfg().sound = e.target.checked; saveConfig(); };
  $('#btnTestAlert').onclick = () => { unlockAudio(); beep(); };
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });
  updateMotionButton();
}

wireMotion();
