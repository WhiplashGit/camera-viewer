/* Shop Cameras: a lightweight web viewer for a Wave VMS system.
 * Talks to the server's REST API (through Wave Cloud relay) with a bearer token.
 * Settings live in localStorage and can optionally be saved to the server
 * as a Stored File so every device shares one setup. */
'use strict';

const APP_VERSION = '20261121211150';
const DEFAULT_BASE = 'https://eee03bc4-c609-4a1a-84a9-6dc9334f4857.relay.vmsproxy.com';
const LS_SESSION = 'cv.session';
const LS_CONFIG = 'cv.config';
const SERVER_CFG_PATH = 'camera-viewer-config.json';
const SNAP_CONCURRENCY = 6;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const DEFAULT_CONFIG = {
  names: {},        // cameraId -> custom name
  hidden: {},       // cameraId -> true
  key: {},          // cameraId -> true (key camera for big alerts)
  groups: [],       // [{id, name, cols, cams: [cameraId]}]
  refreshS: 2,
  rotateS: 10,
  tileMode: 'snap',
  rotating: false,
  activeGroup: 'all',
  updatedAt: 0,
};

let session = store.get(LS_SESSION);
let cfg = Object.assign({}, DEFAULT_CONFIG, store.get(LS_CONFIG) || {});
let cams = [];            // [{id, name, status}]
let camById = new Map();
let rotateTimer = null;
let refreshGen = 0;       // bump to stop the running snapshot loop
let tileHls = [];         // hls.js instances for live tiles
let single = null;        // {group, index, hls, snapTimer}

/* ---------- API ---------- */

class AuthError extends Error {}

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + session.token });
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.json);
  }
  const r = await fetch(session.base + path, { method: opts.method || 'GET', headers, body: opts.body });
  if (r.status === 401) throw new AuthError('Session expired');
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return opts.raw ? r : r.json();
}

async function resolveBase(base) {
  base = base.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  // The cloud relay redirects to a regional host. Browsers drop the
  // Authorization header on cross-host redirects, so talk to the final host.
  const r = await fetch(base + '/api/moduleInformation');
  if (!r.ok) throw new Error('Server did not answer (' + r.status + ')');
  const info = await r.json();
  return { base: new URL(r.url).origin, systemName: info.reply?.systemName || '' };
}

async function login(base, username, password) {
  const { base: finalBase, systemName } = await resolveBase(base);
  const r = await fetch(finalBase + '/rest/v2/login/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.token) throw new Error(body.errorString || 'Wrong username or password');
  session = {
    entered: base, base: finalBase, token: body.token, user: body.username || username,
    systemName, expiresAt: Date.now() + (body.expiresInS || 0) * 1000,
  };
  store.set(LS_SESSION, session);
}

async function logout() {
  if (session) {
    try { await api('/rest/v2/login/sessions/' + encodeURIComponent(session.token), { method: 'DELETE', raw: true }); } catch {}
  }
  session = null;
  store.del(LS_SESSION);
  stopAll();
  showLogin();
}

function handleError(e) {
  if (e instanceof AuthError) {
    const entered = session?.entered;
    session = null; store.del(LS_SESSION); stopAll();
    showLogin('Your session expired. Please sign in again.', entered);
    return true;
  }
  console.error(e);
  return false;
}

async function loadCameras() {
  const list = await api('/rest/v2/devices?_with=id,name,status,deviceType');
  cams = list
    .filter(d => !d.deviceType || d.deviceType === 'Camera')
    .map(d => ({ id: d.id.replace(/[{}]/g, ''), name: d.name, status: d.status || 'Unknown' }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  camById = new Map(cams.map(c => [c.id, c]));
}

/* Watch area helpers (see zones.js). */
function zoneOf(id) {
  const z = cfg.zones && cfg.zones[id];
  return z && z.w > 0.02 && z.h > 0.02 ? z : null;
}
function zoneQuery(z, w) {
  // Size the request to the area's own shape so nothing gets stretched.
  const ar = (z.ar || 4 / 3) * z.w / z.h;
  const h = Math.max(32, Math.min(2048, Math.round(w / ar)));
  const f = v => v.toFixed(4);
  return `size=${w}x${h}&crop=${f(z.x)},${f(z.y)},${f(z.w)}x${f(z.h)}`;
}

async function fetchSnapshot(id, w, h, opts = {}) {
  const z = !opts.full && cfg.zoomView && cfg.zoomView[id] ? zoneOf(id) : null;
  const q = z ? zoneQuery(z, w) : `size=${w}x${h}`;
  const r = await api(`/rest/v2/devices/${id}/image?${q}&format=jpg`, { raw: true });
  return URL.createObjectURL(await r.blob());
}

function hlsUrl(id, quality) { return `${session.base}/hls/${id}.m3u8?${quality}`; }

function attachHls(video, id, quality) {
  const url = hlsUrl(id, quality);
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({
      lowLatencyMode: true,
      liveSyncDurationCount: 2,
      // Live video: keep only a few seconds buffered so memory doesn't grow over hours.
      backBufferLength: 10,
      maxBufferLength: 10,
      maxMaxBufferLength: 20,
      xhrSetup: xhr => xhr.setRequestHeader('Authorization', 'Bearer ' + session.token),
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    return hls;
  }
  return null; // caller falls back to snapshots
}

/* ---------- Config ---------- */

function saveConfig() {
  cfg.updatedAt = Date.now();
  store.set(LS_CONFIG, cfg);
}

function displayName(id) {
  return cfg.names[id] || camById.get(id)?.name || 'Unknown camera';
}

function visibleCams() { return cams.filter(c => !cfg.hidden[c.id]).map(c => c.id); }

function allGroups() {
  const groups = [{ id: 'all', name: 'All cameras', cols: 0, cams: visibleCams() }];
  for (const g of cfg.groups) groups.push(Object.assign({}, g, { cams: g.cams.filter(id => camById.has(id)) }));
  return groups;
}

function activeGroup() {
  const gs = allGroups();
  return gs.find(g => g.id === cfg.activeGroup) || gs[0];
}

function b64encode(str) { return btoa(String.fromCharCode(...new TextEncoder().encode(str))); }
function b64decode(b64) { return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); }

async function saveToServer() {
  saveConfig();
  await api('/rest/v2/storedFiles/' + SERVER_CFG_PATH, { method: 'PUT', json: { data: b64encode(JSON.stringify(cfg)) } });
}

async function loadFromServer() {
  const r = await api('/rest/v2/storedFiles/' + SERVER_CFG_PATH);
  let text = r.data;
  try { text = b64decode(r.data); } catch {}
  const remote = JSON.parse(text);
  cfg = Object.assign({}, DEFAULT_CONFIG, remote);
  saveConfig();
}

/* ---------- Screens ---------- */

function showScreen(id) {
  for (const s of ['login', 'viewer', 'setup']) $('#' + s).hidden = s !== id;
}

function showLogin(msg, base) {
  showScreen('login');
  $('#lgBase').value = base || session?.entered || DEFAULT_BASE;
  $('#lgPass').value = '';
  const err = $('#lgErr');
  err.hidden = !msg; err.textContent = msg || '';
}

async function startViewer() {
  showScreen('viewer');
  flash('Loading cameras…');
  try {
    await loadCameras();
    if (!store.get(LS_CONFIG)) {
      try { await loadFromServer(); } catch {}
    }
  } catch (e) {
    if (!handleError(e)) flash('Could not load cameras: ' + e.message, 6000);
    return;
  }
  flash('');
  renderTabs();
  renderGrid();
  setRotating(cfg.rotating);
  if (typeof startMotion === 'function') startMotion();
  setInterval(refreshStatuses, 60000);
}

async function refreshStatuses() {
  if (!session) return;
  try {
    await loadCameras();
    for (const t of $$('#grid .tile')) {
      const c = camById.get(t.dataset.id);
      t.classList.toggle('offline', !c || c.status === 'Offline');
    }
  } catch (e) { handleError(e); }
}

let flashTimer;
function flash(text, ms = 0) {
  const el = $('#status');
  clearTimeout(flashTimer);
  el.hidden = !text; el.textContent = text;
  if (text && ms) flashTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------- Viewer ---------- */

function renderTabs() {
  const nav = $('#groupTabs');
  nav.textContent = '';
  const gs = allGroups();
  gs.forEach((g, i) => {
    const b = document.createElement('button');
    b.textContent = g.name;
    b.title = `${g.cams.length} cameras` + (i < 9 ? ` (key ${i + 1})` : '');
    b.classList.toggle('active', g.id === activeGroup().id);
    b.onclick = () => { selectGroup(g.id); restartRotation(); };
    nav.appendChild(b);
  });
}

function selectGroup(id) {
  cfg.activeGroup = id; saveConfig();
  renderTabs(); renderGrid();
  if (cfg.rotating) { const g = activeGroup(); if (g.cams.length) openSingle(g, 0); restartRotation(); }
}

function stopTiles() {
  refreshGen++;
  for (const h of tileHls) h.destroy();
  tileHls = [];
  for (const img of $$('#grid img')) if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
}

function stopAll() {
  if (typeof stopMotion === 'function') stopMotion();
  stopTiles();
  closeSingle();
  clearInterval(rotateTimer); rotateTimer = null;
}

function renderGrid() {
  stopTiles();
  const grid = $('#grid');
  grid.textContent = '';
  const g = activeGroup();
  if (!g.cams.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = g.id === 'all' ? 'No cameras to show.' : 'This group is empty. Add cameras in Setup.';
    grid.appendChild(d);
    return;
  }
  const n = g.cams.length;
  const { cols, scroll } = gridLayout(g);
  grid.style.setProperty('--cols', cols);
  grid.classList.toggle('scroll', scroll);
  grid.classList.toggle('phone', isPhone());
  // Scrolling grids get fixed 4:3 rows (aspect-ratio alone collapses inside a grid).
  if (scroll) {
    const gap = 4, w = grid.clientWidth - 8;
    grid.style.setProperty('--rowH', Math.round(((w - gap * (cols - 1)) / cols) * 3 / 4) + 'px');
  }
  $('#btnCols').hidden = !isPhone() || n < 2;
  $('#btnCols').title = `Columns: ${cols} (tap to change)`;
  const live = cfg.tileMode === 'live';
  const tpl = $('#tileTpl');
  g.cams.forEach((id, i) => {
    const t = tpl.content.firstElementChild.cloneNode(true);
    t.dataset.id = id;
    $('.tile-name', t).textContent = displayName(id);
    if (cfg.key[id]) $('.tile-name', t).textContent = '★ ' + displayName(id);
    t.onclick = () => openSingle(g, i);
    if (live) {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.autoplay = true;
      $('.tile-img', t).replaceWith(v);
      const h = attachHls(v, id, 'lo');
      if (h) { tileHls.push(h); t.classList.add('ok'); }
    }
    grid.appendChild(t);
    tileObserver?.observe(t);
  });
  if (!live || !window.Hls || !Hls.isSupported()) runSnapshotLoop(grid, cols);
}

/* ---------- Layout ---------- */

// Phones (and small tablets in portrait) get a scrolling grid with a column
// count the viewer picks; bigger screens fit every tile on screen.
function isPhone() {
  return Math.min(window.innerWidth, window.innerHeight) < 600 || (window.innerWidth < 760 && window.innerHeight > window.innerWidth);
}
function isPortrait() { return window.innerHeight > window.innerWidth; }

function phoneCols() {
  const v = +store.get('cv.phoneCols');
  return v >= 1 && v <= 3 ? v : 2;
}

function gridLayout(g) {
  const n = g.cams.length;
  if (isPhone()) {
    if (isPortrait()) {
      const cols = n === 1 ? 1 : Math.min(n, phoneCols());
      return { cols, scroll: true };
    }
    // Phone on its side: fit up to 6 tiles on screen, scroll beyond that.
    const cols = n <= 2 ? n : n <= 6 ? 3 : 4;
    return { cols, scroll: n > 6 };
  }
  const fit = Math.min(n, Math.ceil(Math.sqrt(n * (window.innerWidth / window.innerHeight) * 3 / 4)));
  const cols = Math.max(1, g.cols || fit);
  return { cols, scroll: Math.ceil(n / cols) > 8 };
}

function cyclePhoneCols() {
  store.set('cv.phoneCols', phoneCols() % 3 + 1);
  renderGrid();
}

// Only refresh tiles that are on screen (matters when scrolling on a phone).
const tileObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const e of entries) e.target._vis = e.isIntersecting;
}, { rootMargin: '200px 0px' }) : null;

async function runSnapshotLoop(grid, cols) {
  const gen = ++refreshGen;
  // Ask the server for roughly the size the tile is drawn at.
  const tileW = (grid.clientWidth / cols) * Math.min(2, window.devicePixelRatio || 1);
  const [w, h] = tileW > 700 ? [960, 720] : tileW > 400 ? [640, 480] : [400, 300];
  while (gen === refreshGen) {
    if (document.hidden || single) { await sleep(500); continue; }
    const tiles = $$('.tile', grid).filter(t => $('img', t) && t._vis !== false);
    const started = Date.now();
    let next = 0;
    const worker = async () => {
      while (next < tiles.length && gen === refreshGen) {
        const t = tiles[next++];
        const img = $('img', t);
        try {
          const url = await fetchSnapshot(t.dataset.id, w, h);
          if (gen !== refreshGen) { URL.revokeObjectURL(url); return; }
          const old = img.src;
          img.src = url;
          if (old.startsWith('blob:')) URL.revokeObjectURL(old);
          t.classList.add('ok'); t.classList.remove('err');
        } catch (e) {
          if (handleError(e)) { refreshGen++; return; }
          t.classList.add('err'); t.classList.remove('ok');
        }
      }
    };
    await Promise.all(Array.from({ length: SNAP_CONCURRENCY }, worker));
    const wait = cfg.refreshS * 1000 - (Date.now() - started);
    await sleep(Math.max(200, wait));
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Single camera ----------
 * Two <video> elements take turns. While one camera shows, the next camera in
 * the rotation starts loading hidden in the other, so switching is instant.
 * A snapshot (which arrives in ~0.1s) covers any gap until live video plays. */

let preload = null;       // player warming up for the next camera
let singleImgUrl = '';

function singleVideos() { return $$('#single video'); }

function startPlayer(video, id) {
  video.classList.remove('show');
  const p = { video, id, playing: false, hls: null };
  p.onPlaying = () => {
    p.playing = true;
    if (single?.cur === p) showPlayer(p);
  };
  video.addEventListener('playing', p.onPlaying);
  p.hls = attachHls(video, id, 'hi');
  return p;
}

function stopPlayer(p) {
  if (!p) return;
  p.video.removeEventListener('playing', p.onPlaying);
  if (p.hls) p.hls.destroy();
  p.video.classList.remove('show');
  p.video.removeAttribute('src');
  p.video.load();
}

function showPlayer(p) {
  for (const v of singleVideos()) v.classList.toggle('show', v === p.video);
  $('#singleImg').hidden = true;
  schedulePreload();
}

function setSingleImg(url) {
  const img = $('#singleImg');
  img.src = url; img.hidden = false;
  if (singleImgUrl) URL.revokeObjectURL(singleImgUrl);
  singleImgUrl = url;
}

function openSingle(group, index, opts = {}) {
  const id = group.cams[index];
  if (!id) return;
  $('#single').hidden = false;
  $('#singleName').textContent = (cfg.key[id] ? '★ ' : '') + displayName(id);
  if (typeof applyStageZoom === 'function') applyStageZoom(id);
  const badge = $('#singleBadge');
  badge.hidden = !opts.badge; badge.textContent = opts.badge || '';

  const old = single ? single.cur : null;
  if (single) { clearTimeout(single.snapTimer); clearTimeout(single.preloadTimer); }

  let cur;
  if (preload && preload.id === id) { cur = preload; preload = null; }
  else {
    stopPlayer(preload); preload = null;
    const free = singleVideos().find(v => !old || v !== old.video);
    cur = startPlayer(free, id);
  }
  single = { group, index, id, cur, snapTimer: null, preloadTimer: null };

  if (!cur.hls) {
    // No hls.js support: fall back to fast snapshots
    if (old !== cur) stopPlayer(old);
    const tick = async () => {
      if (!single || single.id !== id) return;
      try { setSingleImg(await fetchSnapshot(id, 1280, 720, { full: true })); }
      catch (e) { if (handleError(e)) return; }
      if (single && single.id === id) single.snapTimer = setTimeout(tick, 1000);
    };
    tick();
    return;
  }

  if (cur.playing) {          // preloaded and already live: swap instantly
    showPlayer(cur);
    if (old !== cur) stopPlayer(old);
    return;
  }
  // Keep the previous picture up until this camera's snapshot arrives,
  // then show the snapshot until live video starts.
  fetchSnapshot(id, 1280, 720, { full: true }).then(url => {
    if (!single || single.cur !== cur || cur.playing) { URL.revokeObjectURL(url); return; }
    setSingleImg(url);
    for (const v of singleVideos()) if (v !== cur.video) v.classList.remove('show');
    if (old !== cur) stopPlayer(old);
  }).catch(e => { handleError(e); if (old !== cur) stopPlayer(old); });
}

function schedulePreload() {
  if (!single || !cfg.rotating) return;
  clearTimeout(single.preloadTimer);
  const { group, index } = single;
  const n = group.cams.length;
  if (n < 2) return;
  const nextId = group.cams[(index + 1) % n];
  // Start loading the next camera ~8 seconds before it is due.
  const delay = Math.max(0, cfg.rotateS * 1000 - 8000);
  single.preloadTimer = setTimeout(() => {
    if (!single || !cfg.rotating || (preload && preload.id === nextId)) return;
    stopPlayer(preload);
    const free = singleVideos().find(v => v !== single.cur.video);
    preload = startPlayer(free, nextId);
  }, delay);
}

function closeSingle() {
  if (single) {
    clearTimeout(single.snapTimer); clearTimeout(single.preloadTimer);
    stopPlayer(single.cur);
    single = null;
  }
  stopPlayer(preload); preload = null;
  $('#singleImg').hidden = true;
  $('#single').hidden = true;
}

function userStep(d) { stepSingle(d); restartRotation(); }

function stepSingle(d) {
  if (!single) return;
  const { group, index } = single;
  const n = group.cams.length;
  openSingle(group, (index + d + n) % n);
}

/* ---------- Rotation ---------- */

/* Rotate = show each camera in the current group full screen, one after
 * another, switching every cfg.rotateS seconds. */
function setRotating(on) {
  cfg.rotating = !!on; saveConfig();
  $('#btnRotate').classList.toggle('on', cfg.rotating);
  $('#singleRotate').classList.toggle('on', cfg.rotating);
  if (cfg.rotating && !single && $('#setup').hidden && session) {
    const g = activeGroup();
    if (g.cams.length) openSingle(g, 0);
  }
  restartRotation();
}

function restartRotation() {
  clearInterval(rotateTimer); rotateTimer = null;
  if (!cfg.rotating) return;
  rotateTimer = setInterval(() => {
    if (!$('#setup').hidden || $('#viewer').hidden) return;
    if (typeof isKeyAlertActive === 'function' && isKeyAlertActive()) return;
    if (single) stepSingle(1);
    else { const g = activeGroup(); if (g.cams.length) openSingle(g, 0); }
  }, cfg.rotateS * 1000);
}

function userCloseSingle() {
  if (typeof isKeyAlertActive === 'function' && isKeyAlertActive()) { endKeyAlert(true); return; }
  if (cfg.rotating) setRotating(false);
  closeSingle();
}

/* ---------- Setup ---------- */

function openSetup() {
  stopTiles();
  closeSingle();
  showScreen('setup');
  $('#optRefresh').value = String(cfg.refreshS);
  $('#optRotate').value = String(cfg.rotateS);
  $('#optTileMode').value = cfg.tileMode;
  $('#whoami').textContent = `Signed in as ${session.user}` + (session.systemName ? ` to ${session.systemName}` : '');
  $('#syncMsg').textContent = '';
  renderGroupEditor();
  renderCamTable();
  if (typeof renderMotionSettings === 'function') renderMotionSettings();
  if (typeof renderPowerSettings === 'function') renderPowerSettings();
}

function closeSetup() {
  saveConfig();
  showScreen('viewer');
  renderTabs(); renderGrid();
  setRotating(cfg.rotating);
  if (typeof startMotion === 'function') startMotion();
}

function renderGroupEditor() {
  const box = $('#groupList');
  box.textContent = '';
  cfg.groups.forEach((g, gi) => {
    const el = document.createElement('div');
    el.className = 'group';
    el.innerHTML = `
      <div class="group-head">
        <input class="gname" aria-label="Group name">
        <label class="muted">Columns <select class="gcols">
          <option value="0">Auto</option>${[1,2,3,4,5,6,7,8].map(n => `<option value="${n}">${n}</option>`).join('')}
        </select></label>
        <button class="gup" title="Move up">↑</button>
        <button class="gdown" title="Move down">↓</button>
        <button class="gdel danger">Delete</button>
      </div>
      <div class="group-cams"></div>
      <div class="group-add"><select class="gaddsel"></select><button class="gadd">Add</button></div>`;
    const name = $('.gname', el);
    name.value = g.name;
    name.oninput = () => { g.name = name.value || 'Group'; saveConfig(); };
    const cols = $('.gcols', el);
    cols.value = String(g.cols || 0);
    cols.onchange = () => { g.cols = +cols.value; saveConfig(); };
    $('.gup', el).onclick = () => { if (gi > 0) { [cfg.groups[gi - 1], cfg.groups[gi]] = [cfg.groups[gi], cfg.groups[gi - 1]]; saveConfig(); renderGroupEditor(); } };
    $('.gdown', el).onclick = () => { if (gi < cfg.groups.length - 1) { [cfg.groups[gi + 1], cfg.groups[gi]] = [cfg.groups[gi], cfg.groups[gi + 1]]; saveConfig(); renderGroupEditor(); } };
    $('.gdel', el).onclick = () => {
      cfg.groups.splice(gi, 1);
      if (cfg.activeGroup === g.id) cfg.activeGroup = 'all';
      saveConfig(); renderGroupEditor();
    };
    const chips = $('.group-cams', el);
    g.cams.forEach((id, ci) => {
      if (!camById.has(id)) return;
      const chip = document.createElement('span');
      chip.className = 'chip';
      const label = document.createElement('span');
      label.textContent = displayName(id);
      const left = document.createElement('button'); left.textContent = '‹'; left.title = 'Move left';
      left.onclick = () => { if (ci > 0) { [g.cams[ci - 1], g.cams[ci]] = [g.cams[ci], g.cams[ci - 1]]; saveConfig(); renderGroupEditor(); } };
      const rm = document.createElement('button'); rm.textContent = '✕'; rm.title = 'Remove from group';
      rm.onclick = () => { g.cams.splice(ci, 1); saveConfig(); renderGroupEditor(); };
      chip.append(label, left, rm);
      chips.appendChild(chip);
    });
    if (!g.cams.length) { const p = document.createElement('span'); p.className = 'muted'; p.textContent = 'No cameras yet.'; chips.appendChild(p); }
    const sel = $('.gaddsel', el);
    const opt0 = document.createElement('option'); opt0.value = ''; opt0.textContent = 'Choose a camera to add…'; sel.appendChild(opt0);
    for (const c of cams) {
      if (g.cams.includes(c.id)) continue;
      const o = document.createElement('option'); o.value = c.id; o.textContent = displayName(c.id); sel.appendChild(o);
    }
    const add = () => { if (sel.value) { g.cams.push(sel.value); saveConfig(); renderGroupEditor(); } };
    $('.gadd', el).onclick = add;
    sel.ondblclick = add;
    box.appendChild(el);
  });
}

function renderCamTable() {
  const box = $('#camTable');
  box.textContent = '';
  const q = $('#camFilter').value.trim().toLowerCase();
  for (const c of cams) {
    if (q && !(displayName(c.id).toLowerCase().includes(q) || c.name.toLowerCase().includes(q))) continue;
    const row = document.createElement('div');
    row.className = 'cam-row' + (cfg.hidden[c.id] ? ' hidden-cam' : '');
    row.innerHTML = `
      <img alt="" loading="lazy">
      <div class="names"><input aria-label="Custom name"><span class="orig"></span></div>
      <div class="flags"><label title="Pop up this camera when a person, vehicle or animal moves"><input type="checkbox" class="cmotion"> Motion</label>
      <label title="Key camera: bigger alert"><input type="checkbox" class="ckey"> ★ Key</label></div>
      <label><input type="checkbox" class="chide"> Hide</label>
      <button type="button" class="carea" title="Draw an area to zoom in on and watch for motion"></button>`;
    const input = $('input[aria-label]', row);
    input.value = cfg.names[c.id] || '';
    input.placeholder = c.name;
    input.oninput = () => {
      const v = input.value.trim();
      if (v) cfg.names[c.id] = v; else delete cfg.names[c.id];
      saveConfig();
    };
    input.onchange = () => renderGroupEditor();
    $('.orig', row).textContent = `Server name: ${c.name}` + (c.status !== 'Recording' && c.status !== 'Online' ? ` · ${c.status}` : '');
    const key = $('.ckey', row);
    key.checked = !!cfg.key[c.id];
    key.onchange = () => { if (key.checked) cfg.key[c.id] = true; else delete cfg.key[c.id]; saveConfig(); };
    const mot = $('.cmotion', row);
    cfg.noMotion = cfg.noMotion || {};
    mot.checked = !cfg.noMotion[c.id];
    mot.onchange = () => { if (mot.checked) delete cfg.noMotion[c.id]; else cfg.noMotion[c.id] = true; saveConfig(); };
    const area = $('.carea', row);
    area.textContent = zoneOf(c.id) ? '▣ Area set' : '▢ Area';
    area.classList.toggle('on', !!zoneOf(c.id));
    area.onclick = () => openZoneEditor(c.id);
    const hide = $('.chide', row);
    hide.checked = !!cfg.hidden[c.id];
    hide.onchange = () => {
      if (hide.checked) cfg.hidden[c.id] = true; else delete cfg.hidden[c.id];
      row.classList.toggle('hidden-cam', hide.checked); saveConfig();
    };
    lazyThumb($('img', row), c.id);
    box.appendChild(row);
  }
}

const thumbObserver = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbObserver.unobserve(e.target);
    fetchSnapshot(e.target.dataset.cam, 192, 108).then(u => { e.target.src = u; }).catch(handleError);
  }
}) : null;

function lazyThumb(img, id) {
  img.dataset.cam = id;
  if (thumbObserver) thumbObserver.observe(img);
}

/* ---------- Wiring ---------- */

function wire() {
  $('#loginForm').onsubmit = async ev => {
    ev.preventDefault();
    const btn = $('#loginForm button[type=submit]');
    btn.disabled = true; btn.textContent = 'Signing in…';
    $('#lgErr').hidden = true;
    try {
      await login($('#lgBase').value, $('#lgUser').value.trim(), $('#lgPass').value);
      $('#lgPass').value = '';
      await startViewer();
    } catch (e) {
      $('#lgErr').hidden = false;
      $('#lgErr').textContent = e.message === 'Failed to fetch' ? 'Could not reach the server. Check the address and your internet connection.' : e.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  };

  $('#btnRotate').onclick = () => setRotating(!cfg.rotating);
  $('#btnFull').onclick = toggleFullscreen;
  $('#btnFull').hidden = !(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  $('#btnCols').onclick = cyclePhoneCols;
  wireSwipe();
  $('#btnSetup').onclick = openSetup;
  $('#btnDone').onclick = closeSetup;
  $('#singleClose').onclick = userCloseSingle;
  $('#singleRotate').onclick = () => setRotating(!cfg.rotating);
  $('#singlePrev').onclick = () => userStep(-1);
  $('#singleNext').onclick = () => userStep(1);
  $('#btnAddGroup').onclick = () => {
    cfg.groups.push({ id: 'g' + Date.now().toString(36), name: 'New group', cols: 0, cams: [] });
    saveConfig(); renderGroupEditor();
  };
  $('#camFilter').oninput = renderCamTable;
  $('#optRefresh').onchange = e => { cfg.refreshS = +e.target.value; saveConfig(); };
  $('#optRotate').onchange = e => { cfg.rotateS = +e.target.value; saveConfig(); };
  $('#optTileMode').onchange = e => { cfg.tileMode = e.target.value; saveConfig(); };
  $('#btnSaveServer').onclick = async () => {
    $('#syncMsg').textContent = 'Saving…';
    try { await saveToServer(); $('#syncMsg').textContent = 'Saved to server.'; }
    catch (e) { if (!handleError(e)) $('#syncMsg').textContent = 'Could not save: ' + e.message; }
  };
  $('#btnLoadServer').onclick = async () => {
    $('#syncMsg').textContent = 'Loading…';
    try { await loadFromServer(); renderGroupEditor(); renderCamTable(); openSetup(); $('#syncMsg').textContent = 'Loaded from server.'; }
    catch (e) { if (!handleError(e)) $('#syncMsg').textContent = /404/.test(e.message) ? 'Nothing saved on the server yet.' : 'Could not load: ' + e.message; }
  };
  $('#btnLogout').onclick = logout;

  document.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea') || $('#viewer').hidden) return;
    if (single) {
      if (e.key === 'Escape') userCloseSingle();
      else if (e.key === 'ArrowRight') userStep(1);
      else if (e.key === 'ArrowLeft') userStep(-1);
      else if (e.key === 'r' || e.key === 'R') setRotating(!cfg.rotating);
      return;
    }
    const gs = allGroups();
    const i = gs.findIndex(g => g.id === activeGroup().id);
    if (e.key === 'ArrowRight') { selectGroup(gs[(i + 1) % gs.length].id); restartRotation(); }
    else if (e.key === 'ArrowLeft') { selectGroup(gs[(i - 1 + gs.length) % gs.length].id); restartRotation(); }
    else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    else if (e.key === 'r' || e.key === 'R') setRotating(!cfg.rotating);
    else if (/^[1-9]$/.test(e.key) && gs[+e.key - 1]) { selectGroup(gs[+e.key - 1].id); restartRotation(); }
  });

  window.addEventListener('orientationchange', () => setTimeout(() => { if (!$('#viewer').hidden && !single) renderGrid(); }, 300));
  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (!$('#viewer').hidden && !single && !(typeof isLowPower === 'function' && isLowPower())) renderGrid(); }, 400);
  });
}

// Swipe left/right on the full-screen camera to change camera, down to close.
function wireSwipe() {
  const el = $('#single');
  let x0 = 0, y0 = 0, t0 = 0;
  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  el.addEventListener('touchend', e => {
    if (e.target.closest('button') || Date.now() - t0 > 800) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) userStep(dx < 0 ? 1 : -1);
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5) userCloseSingle();
  }, { passive: true });
}

function toggleFullscreen() {
  const d = document, el = d.documentElement;
  if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen)?.call(d);
  else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
}

// Pick up new versions automatically (handy for a TV left running).
setInterval(async () => {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    const { v } = await r.json();
    if (v && v !== APP_VERSION && $('#setup').hidden && !(typeof isKeyAlertActive === 'function' && isKeyAlertActive())) location.reload();
  } catch {}
}, 5 * 60 * 1000);

wire();
if (session?.token) startViewer(); else showLogin();
