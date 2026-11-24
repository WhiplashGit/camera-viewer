/* Owner tools for Shop Cameras.
 * One owner passphrase (set once, stored on the server only as a salted
 * PBKDF2 hash in "camera-viewer-owner.json") unlocks a panel that can delete
 * anything this app keeps on the server: anyone's saved setup (whatever its
 * PIN), the old shared setup file, and suggestions, and can mark suggestions
 * Accepted / Not accepted. Only files whose names start with "camera-viewer"
 * are ever listed, so Wave's own files can't be touched from here.
 * Because everyone signs in with the same Wave login, this stops ordinary
 * users, not someone determined who knows how the server API works.
 * Uses globals from app.js and suggest.js. */
'use strict';

const OWNER_FILE = 'camera-viewer-owner.json';
const OWNER_ITER = 150000;
let ownerUnlocked = false;

const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));

async function ownerHash(pass, saltHex, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: iter }, key, 256);
  return toHex(bits);
}

async function readStored(path) {
  let r;
  try { r = await api('/rest/v2/storedFiles/' + path); }
  catch (e) { if (/404|not ?found/i.test(e.message)) return null; throw e; }
  let txt = r.data; try { txt = b64decode(r.data); } catch {}
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}
const writeStored = (path, obj) => api('/rest/v2/storedFiles/' + path, { method: 'PUT', json: { data: b64encode(JSON.stringify(obj)) } });
const deleteStored = path => api('/rest/v2/storedFiles/' + path, { method: 'DELETE', raw: true });

async function setOwnerPass(pass) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  await writeStored(OWNER_FILE, { salt, iter: OWNER_ITER, hash: await ownerHash(pass, salt, OWNER_ITER), setAt: Date.now() });
}

async function checkOwnerPass(pass) {
  const o = await readStored(OWNER_FILE);
  if (!o || !o.hash) return null;   // not set yet
  return (await ownerHash(pass, o.salt, o.iter || OWNER_ITER)) === o.hash;
}

/* ---------- Panel ---------- */

async function renderOwnerState() {
  const msg = $('#ownMsg');
  $('#ownTools').hidden = !ownerUnlocked;
  $('#ownLock').hidden = ownerUnlocked;
  if (ownerUnlocked) { renderOwnerFiles(); return; }
  try {
    const o = await readStored(OWNER_FILE);
    $('#ownUnlock').textContent = o ? 'Unlock' : 'Set owner passphrase';
    $('#ownPass2Wrap').hidden = !!o;
    msg.textContent = o ? '' : 'No owner passphrase yet. The first one set here becomes the owner passphrase.';
  } catch (e) { if (!handleError(e)) msg.textContent = 'Could not check: ' + e.message; }
}

async function ownerUnlock() {
  const msg = $('#ownMsg'), pass = $('#ownPass').value;
  if (pass.length < 8) { msg.textContent = 'Use at least 8 characters.'; return; }
  msg.textContent = 'Checking…';
  try {
    const ok = await checkOwnerPass(pass);
    if (ok === null) {
      if (pass !== $('#ownPass2').value) { msg.textContent = 'The two passphrases don’t match.'; return; }
      await setOwnerPass(pass);
      msg.textContent = 'Owner passphrase set. Keep it somewhere safe; it can’t be recovered.';
    } else if (!ok) { msg.textContent = 'Wrong passphrase.'; return; }
    else msg.textContent = '';
    ownerUnlocked = true;
    $('#ownPass').value = ''; $('#ownPass2').value = '';
    renderOwnerState();
  } catch (e) { if (!handleError(e)) msg.textContent = 'Could not check: ' + e.message; }
}

function describeFile(path, doc) {
  if (path.startsWith('camera-viewer-suggestions/')) {
    const st = (typeof SUGGEST_STATUS !== 'undefined' && SUGGEST_STATUS[doc?.status]) || { label: 'Pending' };
    return { kind: 'suggestion', title: `💡 ${doc?.name || 'Someone'}: ${(doc?.text || '').slice(0, 120)}`, sub: `${st.label} · ${doc?.t ? new Date(doc.t).toLocaleString() : ''}` };
  }
  if (path === 'camera-viewer-config.json') return { kind: 'setup', title: '⚙ Old shared setup (from before personal copies)', sub: path };
  const m = path.match(/^camera-viewer-(.+)\.json$/);
  return { kind: 'setup', title: `⚙ Saved setup: ${doc?.profile || (m ? m[1] : path)}`, sub: doc?.savedAt ? 'Saved ' + new Date(doc.savedAt).toLocaleString() : path };
}

async function renderOwnerFiles() {
  const box = $('#ownFiles');
  box.textContent = 'Loading…';
  try {
    const all = (await api('/ec2/listDirectory')).map(f => f.path)
      .filter(p => p.startsWith('camera-viewer') && p !== OWNER_FILE).sort();
    const docs = await Promise.all(all.map(p => readStored(p).catch(() => null)));
    box.textContent = '';
    if (!all.length) { box.innerHTML = '<p class="muted">Nothing from this app is stored on the server.</p>'; return; }
    all.forEach((path, i) => {
      const d = describeFile(path, docs[i]);
      const row = document.createElement('div'); row.className = 'own-row';
      const t = document.createElement('div'); t.className = 'own-t';
      const a = document.createElement('div'); a.textContent = d.title;
      const b = document.createElement('div'); b.className = 'muted'; b.textContent = d.sub;
      t.append(a, b);
      const btns = document.createElement('div'); btns.className = 'own-btns';
      if (d.kind === 'suggestion') {
        for (const [st, label] of [['accepted', 'Accept'], ['not-accepted', 'Not accepted'], ['pending', 'Pending']]) {
          const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = label;
          btn.disabled = (docs[i]?.status || 'pending') === st;
          btn.onclick = async () => {
            const note = st === 'pending' ? '' : $('#ownNote').value.trim();
            const doc = Object.assign({}, docs[i], { status: st, statusAt: Date.now(), statusNote: note || undefined });
            delete doc.path;
            try { await writeStored(path, doc); renderOwnerFiles(); } catch (e) { if (!handleError(e)) $('#ownMsg2').textContent = 'Could not save: ' + e.message; }
          };
          btns.appendChild(btn);
        }
      }
      const del = document.createElement('button'); del.type = 'button'; del.className = 'danger'; del.textContent = 'Delete';
      del.onclick = async () => {
        if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Tap again to delete'; setTimeout(() => { del.dataset.armed = ''; del.textContent = 'Delete'; }, 4000); return; }
        try { await deleteStored(path); renderOwnerFiles(); } catch (e) { if (!handleError(e)) $('#ownMsg2').textContent = 'Could not delete: ' + e.message; }
      };
      btns.appendChild(del);
      row.append(t, btns);
      box.appendChild(row);
    });
  } catch (e) { if (!handleError(e)) box.textContent = 'Could not load: ' + e.message; }
}

async function ownerChangePass() {
  const msg = $('#ownMsg2'), p1 = $('#ownNew').value, p2 = $('#ownNew2').value;
  if (p1.length < 8) { msg.textContent = 'Use at least 8 characters.'; return; }
  if (p1 !== p2) { msg.textContent = 'The two passphrases don’t match.'; return; }
  try { await setOwnerPass(p1); $('#ownNew').value = ''; $('#ownNew2').value = ''; msg.textContent = 'Owner passphrase changed.'; }
  catch (e) { if (!handleError(e)) msg.textContent = 'Could not change: ' + e.message; }
}

function wireOwner() {
  $('#ownUnlock').onclick = ownerUnlock;
  $('#ownPass').onkeydown = e => { if (e.key === 'Enter') ownerUnlock(); };
  $('#ownLockBtn').onclick = () => { ownerUnlocked = false; renderOwnerState(); };
  $('#ownRefresh').onclick = renderOwnerFiles;
  $('#ownChange').onclick = ownerChangePass;
  $('#ownPanel').addEventListener('toggle', () => { if ($('#ownPanel').open) renderOwnerState(); });
}

wireOwner();
