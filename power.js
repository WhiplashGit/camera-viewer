/* Power saving for Shop Cameras.
 *
 * After a stretch with no mouse, keyboard or touch (or when the screen is
 * locked / the tab is hidden), the page stops all video and grid refreshing,
 * frees what it can, and shows a black screen. Motion watching on the starred
 * cameras keeps running, so a key-camera alert still wakes the screen.
 * Any input brings everything back as it was.
 * Uses globals from app.js and motion.js. */
'use strict';

let lowPower = false;
let idleTimer = null;
let resumeRotate = false;

function idleMinutes() { return cfg.idleMin === undefined ? 15 : +cfg.idleMin; }

function enterLowPower(reason) {
  if (lowPower || !session || $('#viewer').hidden && $('#setup').hidden) return;
  if (typeof isKeyAlertActive === 'function' && isKeyAlertActive()) return;
  lowPower = true;
  resumeRotate = !!cfg.rotating;
  clearInterval(rotateTimer); rotateTimer = null;
  closeSingle();
  stopTiles();
  $('#grid').textContent = '';                       // drop all tile images
  const n = typeof watchedCams === 'function' && cfg.motion?.enabled !== false ? watchedCams().length : 0;
  $('#sleepMsg').textContent = n
    ? `Power saving. Still watching ${n} starred camera${n === 1 ? '' : 's'} for motion.`
    : 'Power saving. Motion watching is off.';
  $('#sleep').hidden = false;
  $('#sleep').dataset.reason = reason || '';
}

function exitLowPower() {
  if (!lowPower) return;
  lowPower = false;
  $('#sleep').hidden = true;
  if (!$('#viewer').hidden) {
    renderGrid();
    if (resumeRotate) setRotating(true);
  }
  armIdle();
}

function isLowPower() { return lowPower; }

function armIdle() {
  clearTimeout(idleTimer);
  const min = idleMinutes();
  if (!min) return;
  idleTimer = setTimeout(() => enterLowPower('idle'), min * 60 * 1000);
}

function onActivity() {
  if (lowPower) exitLowPower(); else armIdle();
}

function wirePower() {
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
    document.addEventListener(ev, onActivity, { passive: true, capture: true });
  }
  // Screen locked, display asleep, or switched to another tab/app.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) enterLowPower('hidden');
  });
  const sel = $('#optIdle');
  if (sel) {
    sel.onchange = e => { cfg.idleMin = +e.target.value; saveConfig(); armIdle(); };
  }
  armIdle();
}

function renderPowerSettings() {
  const sel = $('#optIdle');
  if (sel) sel.value = String(idleMinutes());
}

wirePower();
