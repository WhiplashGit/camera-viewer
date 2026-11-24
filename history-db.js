/* Motion history storage, shared by the viewer (writes) and history.html (reads).
 * Events live in this browser's IndexedDB: {id, t, cam, name, label, key, img(Blob)}.
 * New events are announced to other open tabs on the 'cv-motion' channel. */
'use strict';

const HistoryDB = (() => {
  const DB = 'cv-history', STORE = 'events';
  const KEEP_DAYS = 14, KEEP_MAX = 2000;
  let dbp = null;
  const chan = 'BroadcastChannel' in window ? new BroadcastChannel('cv-motion') : null;

  function open() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 3);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          s.createIndex('t', 't');
        }
        if (!db.objectStoreNames.contains('sounds')) db.createObjectStore('sounds', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pictures')) db.createObjectStore('pictures', { keyPath: 'id' });
      };
      r.onsuccess = () => {
        const db = r.result;
        // Another tab has a newer version of this page: step aside so it can upgrade.
        db.onversionchange = () => { db.close(); dbp = null; };
        res(db);
      };
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }

  const done = tx => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

  async function add(ev) {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).add(ev);
    await done(tx);
    ev.id = req.result;
    chan?.postMessage({ type: 'added', id: ev.id });
    prune().catch(() => {});
    return ev.id;
  }

  async function get(id) {
    const db = await open();
    return new Promise((res, rej) => {
      const r = db.transaction(STORE).objectStore(STORE).get(id);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }

  /* Newest first. `before` = only events older than this time. */
  async function page({ before = Infinity, limit = 60, filter = () => true } = {}) {
    const db = await open();
    const range = before === Infinity ? null : IDBKeyRange.upperBound(before, true);
    return new Promise((res, rej) => {
      const out = [];
      const r = db.transaction(STORE).objectStore(STORE).index('t').openCursor(range, 'prev');
      r.onsuccess = () => {
        const c = r.result;
        if (!c || out.length >= limit) { res(out); return; }
        if (filter(c.value)) out.push(c.value);
        c.continue();
      };
      r.onerror = () => rej(r.error);
    });
  }

  async function prune() {
    const db = await open();
    const cutoff = Date.now() - KEEP_DAYS * 864e5;
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.index('t').openCursor(IDBKeyRange.upperBound(cutoff)).onsuccess = e => {
      const c = e.target.result; if (c) { c.delete(); c.continue(); }
    };
    const countReq = store.count();
    countReq.onsuccess = () => {
      let extra = countReq.result - KEEP_MAX;
      if (extra <= 0) return;
      store.index('t').openCursor().onsuccess = e => {
        const c = e.target.result; if (c && extra-- > 0) { c.delete(); c.continue(); }
      };
    };
    await done(tx);
  }

  async function clear() {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await done(tx);
    chan?.postMessage({ type: 'cleared' });
  }

  /* Uploaded sounds: {id, name, blob} */
  async function soundsAll() {
    const db = await open();
    return new Promise((res, rej) => {
      const r = db.transaction('sounds').objectStore('sounds').getAll();
      r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
    });
  }
  async function soundPut(s) {
    const db = await open();
    const tx = db.transaction('sounds', 'readwrite'); tx.objectStore('sounds').put(s); await done(tx);
  }
  async function soundDel(id) {
    const db = await open();
    const tx = db.transaction('sounds', 'readwrite'); tx.objectStore('sounds').delete(id); await done(tx);
  }

  /* Uploaded pop-up pictures: {id, name, blob} */
  async function picsAll() {
    const db = await open();
    return new Promise((res, rej) => {
      const r = db.transaction('pictures').objectStore('pictures').getAll();
      r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
    });
  }
  async function picPut(p) {
    const db = await open();
    const tx = db.transaction('pictures', 'readwrite'); tx.objectStore('pictures').put(p); await done(tx);
  }
  async function picDel(id) {
    const db = await open();
    const tx = db.transaction('pictures', 'readwrite'); tx.objectStore('pictures').delete(id); await done(tx);
  }

  return { add, get, page, clear, prune, channel: chan, soundsAll, soundPut, soundDel, picsAll, picPut, picDel };
})();
