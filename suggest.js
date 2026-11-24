/* "Suggest a feature or change" for Shop Cameras.
 * Each suggestion is saved as its own small Stored File on the camera server,
 * "camera-viewer-suggestions/<time>-<random>.json", so two people sending at
 * once never overwrite each other. Everyone signed in can read the list.
 * Stored Files are private to apps like this one; Wave app users don't see them.
 * Uses globals from app.js: api, b64encode, b64decode, store, LS_PROFILE, APP_VERSION, handleError, $. */
'use strict';

const SUGGEST_DIR = 'camera-viewer-suggestions/';

async function sendSuggestion({ name, kind, text }) {
  const t = new Date();
  const file = SUGGEST_DIR + t.toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8) + '.json';
  const doc = { t: t.getTime(), name: name.slice(0, 40), kind, text: text.slice(0, 2000), version: APP_VERSION, device: /Mobi|Android|iPhone/i.test(navigator.userAgent) ? 'phone' : 'computer' };
  await api('/rest/v2/storedFiles/' + file, { method: 'PUT', json: { data: b64encode(JSON.stringify(doc)) } });
}

async function listSuggestions(limit = 40) {
  const all = await api('/ec2/listDirectory?path=' + encodeURIComponent(SUGGEST_DIR));
  const paths = all.map(f => f.path).filter(p => p.startsWith(SUGGEST_DIR)).sort().reverse().slice(0, limit);
  const out = await Promise.all(paths.map(async p => {
    try {
      const r = await api('/rest/v2/storedFiles/' + p);
      let txt = r.data; try { txt = b64decode(r.data); } catch {}
      return JSON.parse(txt);
    } catch { return null; }
  }));
  return out.filter(Boolean).sort((a, b) => b.t - a.t);
}

async function renderSuggestions() {
  const box = $('#sgList');
  box.textContent = 'Loading…';
  try {
    const list = await listSuggestions();
    box.textContent = '';
    if (!list.length) { box.innerHTML = '<p class="muted">No suggestions yet. Be the first!</p>'; return; }
    for (const s of list) {
      const el = document.createElement('div'); el.className = 'sg-item';
      const head = document.createElement('div'); head.className = 'sg-head';
      head.textContent = `${s.kind || 'Idea'} · ${s.name || 'Someone'} · ${new Date(s.t).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
      const body = document.createElement('div'); body.className = 'sg-text'; body.textContent = s.text;
      el.append(head, body); box.appendChild(el);
    }
  } catch (e) { if (!handleError(e)) box.textContent = 'Could not load suggestions: ' + e.message; }
}

function openSuggest() {
  $('#sgName').value = $('#sgName').value || store.get(LS_PROFILE)?.name || '';
  $('#sgMsg').textContent = '';
  $('#suggest').hidden = false;
  $('#sgText').focus();
  renderSuggestions();
}

function wireSuggest() {
  for (const b of ['#btnSuggest', '#btnSuggest2']) if ($(b)) $(b).onclick = openSuggest;
  $('#sgClose').onclick = () => { $('#suggest').hidden = true; };
  $('#suggest').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); $('#suggest').hidden = true; } });
  $('#sgForm').onsubmit = async e => {
    e.preventDefault();
    const text = $('#sgText').value.trim();
    if (text.length < 5) { $('#sgMsg').textContent = 'Please write a little more.'; return; }
    const btn = $('#sgSend'); btn.disabled = true; $('#sgMsg').textContent = 'Sending…';
    try {
      await sendSuggestion({ name: $('#sgName').value.trim(), kind: $('#sgKind').value, text });
      $('#sgText').value = '';
      $('#sgMsg').textContent = 'Thanks! Your suggestion was saved and will be looked at.';
      renderSuggestions();
    } catch (err) { if (!handleError(err)) $('#sgMsg').textContent = 'Could not send: ' + err.message; }
    btn.disabled = false;
  };
  if (location.hash === '#suggest') {
    history.replaceState(null, '', location.pathname);
    const tryOpen = () => (session && !$('#viewer').hidden ? openSuggest() : setTimeout(tryOpen, 500));
    tryOpen();
  }
}

wireSuggest();
