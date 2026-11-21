/* Watch areas for Shop Cameras.
 *
 * Draw a box on a camera (a door, a gate). Motion pop-ups then only look
 * inside that box, and the AI checks a zoomed-in picture of it, which also
 * helps it spot people who are small in the full view. Optionally the grid
 * tile and the full-screen view zoom to the same box.
 *
 * Stored per camera in cfg.zones[id] = {x, y, w, h, ar} (fractions of the
 * picture; ar = the camera's width/height) and cfg.zoomView[id] = true.
 * Uses globals from app.js and motion.js. */
'use strict';

let zoneEdit = null;   // {id, rect: {x,y,w,h}, ar}

function openZoneEditor(id) {
  const z = zoneOf(id);
  zoneEdit = { id, rect: z ? { x: z.x, y: z.y, w: z.w, h: z.h } : null, ar: (z && z.ar) || 4 / 3 };
  $('#zoneTitle').textContent = 'Watch area: ' + displayName(id);
  $('#zoneZoom').checked = !!(cfg.zoomView && cfg.zoomView[id]);
  const img = $('#zoneImg');
  img.removeAttribute('src');
  $('#zoneEd').hidden = false;
  drawZoneRect();
  fetchSnapshot(id, 1280, 960, { full: true }).then(url => {
    img.onload = () => {
      zoneEdit.ar = img.naturalWidth / img.naturalHeight || zoneEdit.ar;
      $('#zoneStage').style.aspectRatio = String(zoneEdit.ar);
      $('#zoneStage').style.width = `min(100%, calc(70vh * ${zoneEdit.ar}))`;
      drawZoneRect();
    };
    img.src = url;
  }).catch(e => handleError(e));
}

function closeZoneEditor() {
  const img = $('#zoneImg');
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  $('#zoneEd').hidden = true;
  zoneEdit = null;
}

function drawZoneRect() {
  const el = $('#zoneRect');
  const r = zoneEdit && zoneEdit.rect;
  el.hidden = !r;
  if (!r) return;
  Object.assign(el.style, { left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.w * 100 + '%', height: r.h * 100 + '%' });
}

function saveZone() {
  if (!zoneEdit) return;
  const { id, rect, ar } = zoneEdit;
  cfg.zones = cfg.zones || {};
  cfg.zoomView = cfg.zoomView || {};
  if (rect && rect.w > 0.03 && rect.h > 0.03) {
    const r4 = v => Math.round(v * 10000) / 10000;
    cfg.zones[id] = { x: r4(rect.x), y: r4(rect.y), w: r4(rect.w), h: r4(rect.h), ar: r4(ar) };
    if ($('#zoneZoom').checked) cfg.zoomView[id] = true; else delete cfg.zoomView[id];
  } else {
    delete cfg.zones[id];
    delete cfg.zoomView[id];
  }
  // The picture the AI sees changed, so start its memory for this camera fresh.
  if (cfg.ignoreSpots) delete cfg.ignoreSpots[id];
  if (typeof camState !== 'undefined') camState.delete(id);
  saveConfig();
  closeZoneEditor();
  renderCamTable();
}

function wireZones() {
  const stage = $('#zoneStage');
  let start = null;
  const pos = e => {
    const b = stage.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) };
  };
  stage.addEventListener('pointerdown', e => {
    if (!zoneEdit) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    start = pos(e);
    zoneEdit.rect = { x: start.x, y: start.y, w: 0, h: 0 };
    drawZoneRect();
  });
  stage.addEventListener('pointermove', e => {
    if (!start || !zoneEdit) return;
    const p = pos(e);
    zoneEdit.rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    drawZoneRect();
  });
  const end = () => { start = null; };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  $('#zoneCancel').onclick = closeZoneEditor;
  $('#zoneClear').onclick = () => { if (zoneEdit) { zoneEdit.rect = null; drawZoneRect(); } };
  $('#zoneSave').onclick = saveZone;
}

/* Full-screen view: zoom the live video to the camera's area. */
function applyStageZoom(id) {
  const stage = $('#singleStage');
  const z = cfg.zoomView && cfg.zoomView[id] ? zoneOf(id) : null;
  stage.classList.toggle('zoomed', !!z);
  if (!z) return;
  const ar = (z.ar || 4 / 3) * z.w / z.h;
  stage.style.setProperty('--ar', ar);
  stage.style.setProperty('--zw', (100 / z.w) + '%');
  stage.style.setProperty('--zh', (100 / z.h) + '%');
  stage.style.setProperty('--zl', (-z.x / z.w * 100) + '%');
  stage.style.setProperty('--zt', (-z.y / z.h * 100) + '%');
}

wireZones();
