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

const MOTION_DEFAULTS = { enabled: true, sensitivity: 'normal', sound: true, intervalS: 3, scope: 'key' };
const TARGETS = {
  person: 'Person', bicycle: 'Bicycle', motorcycle: 'Motorcycle', car: 'Car', truck: 'Truck',
  bus: 'Bus', dog: 'Dog', cat: 'Cat', horse: 'Horse', cow: 'Animal', sheep: 'Animal', bear: 'Animal',
};
const SENS = {               // fraction of the picture that must change, detector min score
  high: { change: 0.0008, score: 0.35 },
  normal: { change: 0.0015, score: 0.45 },
  low: { change: 0.004, score: 0.55 },
};
const DIFF_W = 64, DIFF_H = 36;           // motion grid
const PIXEL_DELTA = 18;                   // grey-level change from the background that counts as "changed"
const BG_ALPHA = 0.15;                    // how fast the background picture adapts
const ROUTINE_AI_MS = 2500;               // with few watched cameras, AI-check each one at least this often
const POPUP_HOLD_MS = 5 * 60 * 1000;      // pop-ups stay until dismissed, or 5 minutes after the last detection
const COOLDOWN_MS = 8000;
const MAX_DETECT_PER_PASS = 4;           // AI checks per pass, most "new" movement first
const NOISE_ALPHA = 0.04;                 // how fast a cell learns it is noisy (~25 passes)
const NOISY = 0.35;                       // cells changing this often are treated as background
const LOG_MAX = 40;                 // don't re-alert the same camera faster than this
const KEY_HOLD_MS = 5 * 60 * 1000;       // key-camera full-screen alert stays until dismissed (✕ / Esc), or 5 minutes after the last detection
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
  const m = cfg.motion;
  if (m.scope === 'key') return cams.map(c => c.id).filter(id => cfg.key[id]);
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
  catch (e) { console.error(e); setMotionStatus('error'); logEvent(watchedCams()[0] || '', 'The AI detector could not load: ' + e.message); return; }
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
        if (c.routine) c.score -= 0.25;
        if (st.urgentUntil && now < st.urgentUntil) c.score += 2;   // confirming a possible person/vehicle
      }
      candidates.sort((a, b) => b.score - a.score);
      lastPass = { at: Date.now(), cams: ids.length, moving: candidates.filter(c => !c.routine).length, ms: Date.now() - started };
      const picked = candidates.slice(0, MAX_DETECT_PER_PASS);
      for (const c of candidates.slice(MAX_DETECT_PER_PASS)) if (!c.routine) logEvent(c.id, 'Movement, waiting for a free AI check');
      for (const c of picked) {
        if (gen !== motionGen) break;
        try { await detectCamera(c); }
        catch (e) { if (handleError(e)) { motionGen++; break; } console.error(e); }
      }
      updateMotionStats();
    }
    const few = watchedCams().length <= 8;
    const wait = (few ? 1 : mcfg().intervalS) * 1000 - (Date.now() - started);
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
  // Motion only ever looks inside the camera's watch area, if it has one.
  const z = zoneOf(id);
  const q = z ? zoneQuery(z, w) : `size=${w}x${h}`;
  const r = await api(`/rest/v2/devices/${id}/image?${q}&format=jpg`, { raw: true });
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
  if (!prev) { st.bg = Float32Array.from(grey); return null; }
  // Exactly the same picture twice means the server handed back a cached frame.
  let same = true;
  for (let i = 0; i < grey.length; i++) if (grey[i] !== prev[i]) { same = false; break; }
  if (same) {
    st.sameCount = (st.sameCount || 0) + 1;
    if (st.sameCount === 3) logEvent(id, 'Server keeps sending the same still picture, so movement can\'t be seen');
  } else st.sameCount = 0;

  const raw = new Uint8Array(grey.length);
  const bg = st.bg;
  for (let i = 0; i < grey.length; i++) {
    if (Math.abs(grey[i] - bg[i]) > PIXEL_DELTA || Math.abs(grey[i] - prev[i]) > PIXEL_DELTA) raw[i] = 1;
    bg[i] += BG_ALPHA * (grey[i] - bg[i]);
  }
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
    if (nb >= 1) { changed[i] = 1; n++; }
  }
  const frac = n / grey.length;
  const lighting = frac > 0.6;                    // whole-picture lighting change (clouds, IR switching)
  if (lighting) { st.bg = Float32Array.from(grey); changed.fill(0); }

  // Learn which cells are always moving, and count only movement in normally still areas.
  st.noise = st.noise || new Float32Array(grey.length);
  let novel = 0;
  for (let i = 0; i < grey.length; i++) {
    if (changed[i] && st.noise[i] < NOISY) novel++;
    st.noise[i] += NOISE_ALPHA * (changed[i] - st.noise[i]);
  }
  const sens = SENS[mcfg().sensitivity] || SENS.normal;
  const score = novel / grey.length;
  if (!st.peak || score > st.peak.score || Date.now() - st.peak.t > 60000) st.peak = { score, t: Date.now() };
  // With only a few watched cameras, also run the AI on each one regularly, so a
  // person is caught even if the picture change was too small to notice.
  const urgent = st.urgentUntil && Date.now() < st.urgentUntil;
  const routine = urgent || (watchedCams().length <= 8 && (!st.lastDetect || Date.now() - st.lastDetect > ROUTINE_AI_MS));
  if ((score < sens.change || lighting) && !routine) return null;
  return { id, changed, score, routine: score < sens.change || lighting };
}

function near(a, b) {
  const ax = a[0] + a[2] / 2, ay = a[1] + a[3] / 2, bx = b[0] + b[2] / 2, by = b[1] + b[3] / 2;
  const size = Math.max(a[2], a[3], b[2], b[3]);
  return Math.hypot(ax - bx, ay - by) <= Math.max(4 * size, 80);
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
}

async function detectCamera({ id, routine }) {
  const st = camState.get(id);
  const now = Date.now();
  st.lastDetect = now;
  const sens = SENS[mcfg().sensitivity] || SENS.normal;
  const big = await snapBitmap(id, 640, 360);
  let dets;
  const t0 = performance.now();
  try { dets = await motionModel.detect(big, 10, sens.score); }
  catch (e) { big.close?.(); throw e; }
  stat('dets', performance.now() - t0);

  // `known` remembers objects that sit in one place (parked cars, a bike against
  // a wall). Their outlines jitter from check to check, especially when a shadow
  // or flag passes over them, so they only count if they really move away.
  // Anything new or moved must show up in two checks in a row before it pops up,
  // which filters out one-off misreads.
  st.known = (st.known || []).filter(k => now - k.lastSeen < 5 * 60 * 1000);
  const pending = (st.pending || []).filter(p => now - p.t < 8000);
  st.pending = [];
  const firstLook = !st.seenOnce;
  st.seenOnce = true;
  const hits = [];
  const W = big.width, H = big.height;
  const ignored = (cfg.ignoreSpots && cfg.ignoreSpots[id]) || [];
  for (const d of dets) {
    const label = TARGETS[d.class];
    if (!label) continue;
    const box = d.bbox;
    const norm = [box[0] / W, box[1] / H, box[2] / W, box[3] / H];
    if (ignored.some(s => s.label === label && iou(s.box, norm) > 0.3)) continue;   // marked "not real" by you
    // Confirmed if the same kind of object was "possible" on the last check
    // anywhere nearby. A walking person can move more than their own width
    // between checks, so this compares distance, not overlap.
    if (pending.some(p => p.label === label && near(p.bbox, box))) {
      hits.push({ label, score: d.score, bbox: box, norm });
      continue;
    }
    let best = null, bestIou = 0;
    for (const k of st.known) {
      if (k.label !== label) continue;
      const v = iou(k.bbox, box);
      if (v > bestIou) { bestIou = v; best = k; }
    }
    if (best && bestIou > 0.35) { best.lastSeen = now; continue; }   // same object, same place
    // New, or moved well away from where it was.
    if (best && bestIou > 0) { best.bbox = box; best.lastSeen = now; }
    else st.known.push({ label, bbox: box, lastSeen: now });
    if (!firstLook) st.pending.push({ label, bbox: box, t: now });
  }
  if (st.pending.length) st.urgentUntil = now + 6000;   // confirm on the very next pass

  if (!hits.length) {
    big.close?.();
    if (st.pending.length) { logEvent(id, `Possible ${[...new Set(st.pending.map(p => p.label))].join(', ')}, double-checking`); return; }
    if (routine && !firstLook) return;   // quiet routine check: don't fill the log
    const seen = [...new Set(dets.map(d => TARGETS[d.class]).filter(Boolean))];
    logEvent(id, seen.length ? `AI saw ${seen.join(', ')}, but it wasn't moving` : firstLook ? 'Started watching' : 'Movement checked, no person, vehicle or animal');
    return;
  }
  // Remember where the confirmed objects are now, so they only re-alert if they keep moving.
  for (const h of hits) {
    let best = null, bestIou = 0;
    for (const k of st.known) if (k.label === h.label) { const v = iou(k.bbox, h.bbox); if (v > bestIou) { bestIou = v; best = k; } }
    if (best) { best.bbox = h.bbox; best.lastSeen = now; } else st.known.push({ label: h.label, bbox: h.bbox, lastSeen: now });
  }
  st.lastHit = now;
  logEvent(id, 'Pop-up: ' + [...new Set(hits.map(h => h.label))].join(', '), true);
  onDetection(id, hits, big);
}

/* ---------- Activity log ---------- */

const activity = [];
let lastPass = null;
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
  let peakTxt = '';
  let best = null;
  for (const [id, st] of camState) if (st.peak && now - st.peak.t <= 60000 && (!best || st.peak.score > best.score)) best = { id, score: st.peak.score };
  if (best) peakTxt = ` Biggest movement: ${(best.score * 100).toFixed(2)}% on ${displayName(best.id)}.`;
  const pass = lastPass ? ` Last pass: ${lastPass.moving} of ${lastPass.cams} cameras had new movement, took ${(lastPass.ms / 1000).toFixed(1)} s.` : '';
  return `Last minute: ${s.length} snapshots compared, ${d.length} AI checks` + (d.length ? ` (about ${avg} ms each)` : '') + '.' + pass + peakTxt;
}

function updateMotionStats() {
  const el = $('#motionStats');
  const n = watchedCams().length;
  if (el) el.textContent = !mcfg().enabled ? 'Motion pop-ups are paused.'
    : !n ? 'No cameras are being watched. Star a camera below (★ Key) to watch it.'
    : `Watching ${n} camera${n === 1 ? '' : 's'}` + (n <= 8 ? ', checking each one every second. ' : '. ') + motionStatsText();
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
      <span class="spacer"></span><span class="popup-time"></span>
      <button class="popup-ignore" title="Not a real person/vehicle: never alert for this spot again">Not real</button>
      <button class="popup-x" title="Dismiss">✕</button></div>`;
    el.onclick = e => {
      if (e.target.closest('.popup-x')) { dismissPopup(id); return; }
      if (e.target.closest('.popup-ignore')) { ignoreSpots(id, popups.get(id)?.hits || []); dismissPopup(id); return; }
      openSingle({ id: 'motion', name: displayName(id), cams: [id] }, 0, { badge: label });
      dismissPopup(id);
    };
    box.prepend(el);
    p = { el, canvas: $('canvas', el) };
    popups.set(id, p);
  }
  $('.popup-name', p.el).textContent = (cfg.key[id] ? '★ ' : '') + displayName(id);
  $('.popup-label', p.el).textContent = label;
  p.hits = hits;
  p.count = (p.count || 0) + 1;
  $('.popup-time', p.el).textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + (p.count > 1 ? ` ×${p.count}` : '');
  updateDismissAll();
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

function ignoreSpots(id, hits) {
  cfg.ignoreSpots = cfg.ignoreSpots || {};
  const list = cfg.ignoreSpots[id] = cfg.ignoreSpots[id] || [];
  for (const h of hits) if (h.norm) list.push({ label: h.label, box: h.norm.map(v => Math.round(v * 1000) / 1000) });
  saveConfig();
  logEvent(id, `Marked as not real. That spot will be ignored (${list.length} ignored spot${list.length === 1 ? '' : 's'} on this camera)`);
  if (keyAlert && keyAlert.id === id) endKeyAlert(true);
}

function dismissPopup(id) {
  const p = popups.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  p.el.remove();
  popups.delete(id);
  updateDismissAll();
}

function updateDismissAll() {
  const b = $('#popupsClear');
  if (b) b.hidden = popups.size < 2;
}

function keyCameraAlert(id, label, fresh) {
  if (typeof isLowPower === 'function' && isLowPower()) exitLowPower();
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
  $('#singleIgnore').hidden = false;
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
  $('#singleIgnore').hidden = true;
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
  $('#optScope').value = m.scope;
  updateMotionStats();
}

async function aiTest() {
  const id = $('#aiTestCam').value;
  const msg = $('#aiTestMsg');
  if (!id) return;
  msg.textContent = 'Loading the AI…';
  try {
    await loadModel();
    msg.textContent = 'Checking…';
    const img = await snapBitmap(id, 1280, 720);
    const dets = await motionModel.detect(img, 20, 0.2);
    const cv = $('#aiTestCanvas');
    cv.width = img.width; cv.height = img.height; cv.hidden = false;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0); img.close?.();
    ctx.lineWidth = 3; ctx.font = 'bold 22px sans-serif';
    for (const d of dets) {
      const [x, y, w, h] = d.bbox;
      const target = !!TARGETS[d.class];
      ctx.strokeStyle = ctx.fillStyle = target ? '#ffcc00' : '#8b97a3';
      ctx.strokeRect(x, y, w, h);
      ctx.fillText(`${d.class} ${Math.round(d.score * 100)}%`, x + 4, Math.max(22, y - 6));
    }
    const people = dets.filter(d => TARGETS[d.class]).map(d => `${TARGETS[d.class]} ${Math.round(d.score * 100)}%`);
    msg.textContent = people.length ? 'Found: ' + people.join(', ') : `No person, vehicle or animal found (${dets.length} other object${dets.length === 1 ? '' : 's'}).`;
  } catch (e) { if (!handleError(e)) msg.textContent = 'Could not check: ' + e.message; }
}

function fillAiTestCams() {
  const sel = $('#aiTestCam');
  const keep = sel.value;
  sel.textContent = '';
  const ids = [...cams.map(c => c.id).filter(id => cfg.key[id]), ...cams.map(c => c.id).filter(id => !cfg.key[id])];
  for (const id of ids) { const o = document.createElement('option'); o.value = id; o.textContent = (cfg.key[id] ? '★ ' : '') + displayName(id); sel.appendChild(o); }
  if (keep) sel.value = keep;
}

function wireMotion() {
  $('#aiTestBtn').onclick = aiTest;
  $('#aiTest').addEventListener('toggle', fillAiTestCams);
  $('#btnMotion').onclick = toggleMotion;
  $('#optMotionOn').onchange = e => { mcfg().enabled = e.target.checked; saveConfig(); };
  $('#optSens').onchange = e => { mcfg().sensitivity = e.target.value; saveConfig(); };
  $('#optMotionEvery').onchange = e => { mcfg().intervalS = +e.target.value; saveConfig(); };
  $('#optSound').onchange = e => { mcfg().sound = e.target.checked; saveConfig(); };
  $('#optScope').onchange = e => { mcfg().scope = e.target.value; saveConfig(); updateMotionStats(); };
  $('#btnTestAlert').onclick = () => { unlockAudio(); beep(); };
  $('#singleIgnore').onclick = () => {
    if (!keyAlert) return;
    const id = keyAlert.id;
    ignoreSpots(id, popups.get(id)?.hits || []);
    dismissPopup(id);
  };
  $('#btnClearIgnored').onclick = () => {
    const n = Object.values(cfg.ignoreSpots || {}).reduce((a, l) => a + l.length, 0);
    cfg.ignoreSpots = {}; saveConfig();
    $('#ignoredMsg').textContent = n ? `Cleared ${n} spot${n === 1 ? '' : 's'}.` : 'There were none.';
  };
  $('#popupsClear').onclick = () => { for (const id of [...popups.keys()]) dismissPopup(id); };
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });
  updateMotionButton();
}

wireMotion();
