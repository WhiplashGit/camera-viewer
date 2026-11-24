/* Extras for Shop Cameras:
 *  - right-click (or long-press on Android) a camera for its settings
 *  - menu bar position (top, bottom, left, right)
 *  - record your own alert sound with the microphone
 *  - fun pop-up pictures shown when a camera has motion
 * Uses globals from app.js and motion.js. Pictures are kept in this browser. */
'use strict';

/* ---------- Menu bar position ---------- */

function applyBarPos() {
  document.body.dataset.bar = cfg.barPos || 'top';
}

/* ---------- Right-click camera menu ---------- */

let camMenuEl = null;

function closeCamMenu() {
  if (camMenuEl) { camMenuEl.remove(); camMenuEl = null; }
}

function refreshAfterCamChange() {
  saveConfig();
  if (!$('#viewer').hidden) { renderTabs(); renderGrid(); }
  if (single) $('#singleName').textContent = (cfg.key[baseId(single.id)] ? '★ ' : '') + displayName(single.id);
}

function openCamMenu(viewId, x, y) {
  closeCamMenu();
  const id = baseId(viewId);
  cfg.noMotion = cfg.noMotion || {};
  const el = document.createElement('div');
  el.className = 'cam-menu';
  el.innerHTML = `
    <div class="cm-title"></div>
    <label class="cm-row">Name <input class="cm-name" type="text" maxlength="60"></label>
    <label class="cm-row cm-check"><input type="checkbox" class="cm-key"> ★ Key camera (red pop-up)</label>
    <label class="cm-row cm-check"><input type="checkbox" class="cm-motion"> Motion pop-ups</label>
    <label class="cm-row">Sound <span class="cm-inline"><select class="cm-sound"></select><button type="button" class="cm-play" title="Play">▶</button></span></label>
    <label class="cm-row">Picture <select class="cm-pic"></select></label>
    <div class="cm-btns">
      <button type="button" class="cm-area"></button>
      <button type="button" class="cm-open">Open full screen</button>
      <button type="button" class="cm-hide">Hide camera</button>
    </div>
    <div class="cm-btns"><span class="spacer"></span><button type="button" class="cm-close primary">Done</button></div>`;
  $('.cm-title', el).textContent = displayName(viewId);
  const name = $('.cm-name', el);
  name.value = cfg.names[viewId] || '';
  name.placeholder = isAreaView(viewId) ? displayName(id) + ' · area' : (camById.get(id)?.name || '');
  name.onchange = () => {
    const v = name.value.trim();
    if (v) cfg.names[viewId] = v; else delete cfg.names[viewId];
    $('.cm-title', el).textContent = displayName(viewId);
    refreshAfterCamChange();
  };
  const key = $('.cm-key', el);
  key.checked = !!cfg.key[id];
  key.onchange = () => { if (key.checked) cfg.key[id] = true; else delete cfg.key[id]; refreshAfterCamChange(); };
  const mot = $('.cm-motion', el);
  mot.checked = !cfg.noMotion[id];
  mot.onchange = () => { if (mot.checked) delete cfg.noMotion[id]; else cfg.noMotion[id] = true; saveConfig(); };
  const snd = $('.cm-sound', el);
  for (const [k, n] of soundChoices()) { const o = document.createElement('option'); o.value = k; o.textContent = '♪ ' + n; snd.appendChild(o); }
  snd.value = soundFor(id);
  snd.onchange = () => { cfg.sounds = cfg.sounds || {}; cfg.sounds[id] = snd.value; saveConfig(); playSound(snd.value); };
  $('.cm-play', el).onclick = () => playSound(snd.value);
  fillPicSelect($('.cm-pic', el), id, true);
  const area = $('.cm-area', el);
  area.textContent = zoneOf(id) ? '▣ Change watch area' : '▢ Draw watch area';
  area.onclick = () => { closeCamMenu(); openZoneEditor(id); };
  $('.cm-open', el).onclick = () => {
    closeCamMenu();
    const g = activeGroup(), i = g.cams.indexOf(viewId);
    if (i >= 0) openSingle(g, i); else openSingle({ id: 'one', name: displayName(viewId), cams: [viewId] }, 0);
  };
  const hide = $('.cm-hide', el);
  hide.hidden = isAreaView(viewId);
  hide.textContent = cfg.hidden[id] ? 'Show camera' : 'Hide camera';
  hide.onclick = () => { if (cfg.hidden[id]) delete cfg.hidden[id]; else cfg.hidden[id] = true; closeCamMenu(); refreshAfterCamChange(); };
  $('.cm-close', el).onclick = closeCamMenu;
  el.addEventListener('pointerdown', e => e.stopPropagation());
  el.addEventListener('click', e => e.stopPropagation());
  document.body.appendChild(el);
  // Keep it on screen.
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  camMenuEl = el;
}

function wireCamMenu() {
  document.addEventListener('pointerdown', e => { if (camMenuEl && !camMenuEl.contains(e.target)) closeCamMenu(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && camMenuEl) { e.stopPropagation(); closeCamMenu(); } }, true);
  $('#singleStage').addEventListener('contextmenu', e => {
    if (!single) return;
    e.preventDefault();
    openCamMenu(single.id, e.clientX, e.clientY);
  });
}

/* ---------- Record a sound ---------- */

let recorder = null;

async function toggleRecording() {
  const btn = $('#soundRec'), msg = $('#soundMsg');
  if (recorder) { recorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { msg.textContent = 'This browser can’t record sound. Try Chrome, or upload a file instead.'; return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { msg.textContent = 'The microphone is blocked. Allow it for this site in your browser settings.'; return; }
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const stopTimer = setTimeout(() => recorder && recorder.state === 'recording' && recorder.stop(), 10000);
  recorder.onstop = async () => {
    clearTimeout(stopTimer);
    stream.getTracks().forEach(t => t.stop());
    const type = recorder.mimeType || 'audio/webm';
    recorder = null;
    btn.textContent = '🎙 Record a sound'; btn.classList.remove('rec');
    const blob = new Blob(chunks, { type });
    if (blob.size < 500) { msg.textContent = 'Nothing was recorded. Try again.'; return; }
    const when = new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const ext = /mp4|aac/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'webm';
    try {
      const k = await addCustomSound(new File([blob], `Recording ${when}.${ext}`, { type }));
      msg.textContent = 'Recorded. Pick it for a camera below.';
      renderCustomSounds(); renderCamTable(); playSound(k);
    } catch (e) { msg.textContent = 'Could not use that recording: ' + e.message; }
  };
  recorder.start();
  btn.textContent = '■ Stop recording'; btn.classList.add('rec');
  msg.textContent = 'Recording… (up to 10 seconds)';
}

/* ---------- Pop-up pictures ---------- */

const customPics = new Map();   // id -> {id, name, blob, url}

async function loadPics() {
  if (typeof HistoryDB === 'undefined' || !HistoryDB.picsAll) return;
  try { for (const p of await HistoryDB.picsAll()) customPics.set(p.id, p); } catch (e) { console.error(e); }
}

function picUrl(p) { return p.url || (p.url = URL.createObjectURL(p.blob)); }

function fillPicSelect(sel, id, always) {
  sel.textContent = '';
  if (!customPics.size && !always) { sel.hidden = true; return; }
  sel.hidden = false;
  const none = document.createElement('option'); none.value = ''; none.textContent = customPics.size ? '🖼 No picture' : '🖼 Upload one in Setup first'; sel.appendChild(none);
  for (const p of customPics.values()) { const o = document.createElement('option'); o.value = p.id; o.textContent = '🖼 ' + p.name; sel.appendChild(o); }
  sel.value = (cfg.pictures && customPics.has(cfg.pictures[id])) ? cfg.pictures[id] : '';
  sel.onchange = () => {
    cfg.pictures = cfg.pictures || {};
    if (sel.value) cfg.pictures[id] = sel.value; else delete cfg.pictures[id];
    saveConfig();
    if (sel.value) showFunPicture(id, 'Preview', true);
  };
}

/* Shrink big photos so they're quick to show and small to keep. */
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  if (file.type === 'image/gif' && file.size < 3 * 1024 * 1024) return file;   // keep GIFs animated
  return new Promise(res => c.toBlob(b => res(b || file), 'image/png'));
}

async function addPic(file) {
  if (file.size > 15 * 1024 * 1024) throw new Error('That picture is over 15 MB.');
  const blob = await shrinkImage(file);
  const id = 'p' + Date.now().toString(36);
  const p = { id, name: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Picture', blob };
  await HistoryDB.picPut(p);
  customPics.set(id, p);
  return p;
}

async function removePic(id) {
  const p = customPics.get(id);
  if (!p) return;
  await HistoryDB.picDel(id);
  if (p.url) URL.revokeObjectURL(p.url);
  customPics.delete(id);
  for (const [cam, v] of Object.entries(cfg.pictures || {})) if (v === id) delete cfg.pictures[cam];
  saveConfig();
}

function renderPics() {
  const box = $('#customPics');
  if (!box) return;
  box.textContent = '';
  if (!customPics.size) { box.innerHTML = '<span class="muted">None yet.</span>'; return; }
  for (const p of customPics.values()) {
    const chip = document.createElement('span'); chip.className = 'chip pic-chip';
    const img = document.createElement('img'); img.src = picUrl(p); img.alt = '';
    const n = document.createElement('span'); n.textContent = p.name;
    const del = document.createElement('button'); del.textContent = '✕'; del.title = 'Delete this picture';
    del.onclick = async () => { await removePic(p.id); renderPics(); renderCamTable(); };
    chip.append(img, n, del);
    box.appendChild(chip);
  }
}

let funTimer = null;
function showFunPicture(id, label, preview) {
  const pid = cfg.pictures && cfg.pictures[id];
  const p = pid && customPics.get(pid);
  if (!p) return;
  let el = $('#funPic');
  if (!el) {
    el = document.createElement('div');
    el.id = 'funPic'; el.className = 'fun-pic';
    el.innerHTML = '<img alt=""><div class="fun-cap"></div>';
    el.onclick = () => { el.hidden = true; };
    document.body.appendChild(el);
  }
  $('img', el).src = picUrl(p);
  $('.fun-cap', el).textContent = `${displayName(id)}: ${label}`;
  el.hidden = false;
  el.classList.remove('in'); void el.offsetWidth; el.classList.add('in');
  clearTimeout(funTimer);
  funTimer = setTimeout(() => { el.hidden = true; }, preview ? 2500 : 5000);
}

/* ---------- Wiring ---------- */

function wireExtras() {
  applyBarPos();
  wireCamMenu();
  const bar = $('#optBar');
  if (bar) bar.onchange = e => { cfg.barPos = e.target.value; saveConfig(); applyBarPos(); };
  const rec = $('#soundRec');
  if (rec) rec.onclick = toggleRecording;
  const pf = $('#picFile');
  if (pf) pf.onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const msg = $('#picMsg');
    msg.textContent = 'Adding…';
    try { const p = await addPic(f); msg.textContent = `Added "${p.name}". Pick it for a camera below.`; renderPics(); renderCamTable(); }
    catch (err) { msg.textContent = /decode|source|InvalidState/i.test(err.message + err.name) ? 'This browser can’t open that picture. Try a JPG or PNG.' : err.message; }
  };
  loadPics().then(() => { if (!$('#setup').hidden) { renderPics(); renderCamTable(); } });
}

wireExtras();
