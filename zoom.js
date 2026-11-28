/* Zoom in on the full-screen camera.
 * Computers: scroll wheel or trackpad pinch zooms at the pointer, drag to move
 * around, double-click to zoom in 2.5x / back out, keys + - 0.
 * Phones/tablets: pinch to zoom, drag with one finger to move, double-tap.
 * Zoom resets when the camera changes or the view closes. Rotation pauses
 * while zoomed in. */
const ZOOM_MAX = 8;
let zs = 1, zx = 0, zy = 0;   // scale and translate (px) of #singlePan

function isZoomed() { return zs > 1.001; }

function zoomApply() {
  const el = $('#single'), pan = $('#singlePan');
  const w = el.clientWidth, h = el.clientHeight;
  zs = Math.min(ZOOM_MAX, Math.max(1, zs));
  // Keep the picture covering the screen: no empty edges when panning.
  zx = Math.min(0, Math.max(w * (1 - zs), zx));
  zy = Math.min(0, Math.max(h * (1 - zs), zy));
  pan.style.transform = isZoomed() ? `translate(${zx}px, ${zy}px) scale(${zs})` : '';
  el.classList.toggle('zooming', isZoomed());
  const b = $('#singleZoom');
  b.hidden = !isZoomed();
  b.textContent = (Math.round(zs * 10) / 10) + '×';
}

/* Zoom by factor f keeping screen point (px, py) fixed. */
function zoomAt(f, px, py) {
  const ns = Math.min(ZOOM_MAX, Math.max(1, zs * f));
  const k = ns / zs;
  zx = px - (px - zx) * k; zy = py - (py - zy) * k; zs = ns;
  zoomApply();
}

function zoomReset() { zs = 1; zx = 0; zy = 0; zoomApply(); }

function zoomCenter() {
  const el = $('#single');
  return [el.clientWidth / 2, el.clientHeight / 2];
}

function wireZoom() {
  const el = $('#single');
  const local = e => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  // Mouse wheel / trackpad (trackpad pinch arrives as wheel + ctrlKey).
  el.addEventListener('wheel', e => {
    if (e.target.closest('.single-top')) return;
    e.preventDefault();
    const [px, py] = local(e);
    const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(Math.exp(-d * (e.ctrlKey ? 0.01 : 0.002)), px, py);
  }, { passive: false });

  // Pointers: one = drag to pan (when zoomed), two = pinch.
  const pts = new Map();
  let pinch = null, lastTap = 0, moved = false;
  el.addEventListener('pointerdown', e => {
    if (e.target.closest('.single-top') || e.button > 0) return;
    pts.set(e.pointerId, local(e));
    moved = false;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: zs };
    }
    if (isZoomed() || pts.size === 2) { try { el.setPointerCapture(e.pointerId); } catch {} }
  });
  el.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId), cur = local(e);
    pts.set(e.pointerId, cur);
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      // pan with the midpoint, then scale about it
      zx += (cur[0] - prev[0]) / 2; zy += (cur[1] - prev[1]) / 2;
      zoomAt((pinch.s * d / pinch.d) / zs, mx, my);
      moved = true;
    } else if (pts.size === 1 && isZoomed()) {
      zx += cur[0] - prev[0]; zy += cur[1] - prev[1];
      if (Math.abs(cur[0] - prev[0]) + Math.abs(cur[1] - prev[1]) > 0) moved = true;
      el.classList.add('dragging');
      zoomApply();
    }
  });
  const up = e => {
    if (!pts.has(e.pointerId)) return;
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    el.classList.remove('dragging');
    // Double-tap / double-click: zoom in 2.5x there, or back out.
    if (e.type === 'pointerup' && pts.size === 0 && !moved) {
      const now = Date.now();
      if (now - lastTap < 320) {
        lastTap = 0;
        if (isZoomed()) zoomReset(); else zoomAt(2.5, p[0], p[1]);
      } else lastTap = now;
    }
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  // Desktop double-click is handled above; stop the browser selecting things.
  el.addEventListener('dblclick', e => e.preventDefault());

  $('#singleZoom').onclick = zoomReset;

  document.addEventListener('keydown', e => {
    if (el.hidden || e.target.matches('input, select, textarea')) return;
    const [cx, cy] = zoomCenter();
    if (e.key === '+' || e.key === '=') zoomAt(1.5, cx, cy);
    else if (e.key === '-' || e.key === '_') zoomAt(1 / 1.5, cx, cy);
    else if (e.key === '0') zoomReset();
  });
  window.addEventListener('resize', () => { if (!el.hidden) zoomApply(); });

  // Reset when the camera changes or the view closes.
  const _open = openSingle, _close = closeSingle;
  openSingle = function (group, index, opts) {
    const was = single && single.id;
    const r = _open.apply(this, arguments);
    if (!single || single.id !== was) zoomReset();
    return r;
  };
  closeSingle = function () { zoomReset(); return _close.apply(this, arguments); };
}

wireZoom();
