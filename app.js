'use strict';
(() => {
/* =========================================================================
   Private PDF Signer — offline, single-file PDF signing.
   Coordinates of placed items are stored in PDF points (1/72 in) relative to
   the top-left of the page *as displayed* (rotation applied). Screen pixels
   are always derived from them (pt * scale), so zooming never moves items.
   ========================================================================= */

const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
const isTouchUI = () => matchMedia('(max-width: 860px)').matches;

const ICON = {
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
  pages: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="3" width="13" height="16" rx="2"/><path d="M4 7v12a2 2 0 0 0 2 2h10"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>',
  draw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c3-1 4.5-6 6.5-6S11 16 13 16s2.5-3 4-3 2 2 4 2"/></svg>',
  type: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>',
};

/* ---------------------------------------------------------------- fonts */
const FONTS = {
  sans:       { label: 'Sans',          css: 'Arial, "Helvetica Neue", Helvetica, sans-serif' },
  serif:      { label: 'Serif',         css: 'Georgia, "Times New Roman", Times, serif' },
  mono:       { label: 'Monospace',     css: '"Courier New", Courier, monospace' },
  dancing:    { label: 'Dancing Script',css: '"Dancing Script", cursive', script: true },
  vibes:      { label: 'Great Vibes',   css: '"Great Vibes", cursive', script: true },
  sacramento: { label: 'Sacramento',    css: '"Sacramento", cursive', script: true },
  caveat:     { label: 'Caveat',        css: '"Caveat", cursive', script: true },
};
const SIG_FONTS = ['dancing', 'vibes', 'sacramento', 'caveat'];
const fontCss = (key, px) => `${px}px ${(FONTS[key] || FONTS.sans).css}`;
const fontsReady = Promise.all(['Dancing Script', 'Great Vibes', 'Sacramento', 'Caveat']
  .map(f => document.fonts.load(`40px "${f}"`).catch(() => null))).then(() => document.fonts.ready);

/* ------------------------------------------------- embedded libraries */
function b64ToBytes(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function gunzip(u8) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser is too old to run the signer. Please use a current version of Chrome, Edge, Firefox or Safari.');
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const packs = {};
function unpack(id) {
  return packs[id] || (packs[id] = (async () => {
    const el = document.getElementById(id);
    if (!el) throw new Error('Missing embedded resource: ' + id);
    const data = await gunzip(b64ToBytes(el.textContent.replace(/\s+/g, '')));
    el.textContent = '';
    return data;
  })());
}
const unpackText = async id => new TextDecoder().decode(await unpack(id));

function injectScript(code, isModule) {
  return new Promise((resolve, reject) => {
    const key = '__signerLoaded_' + uid();
    const timer = setTimeout(() => { delete globalThis[key]; reject(new Error('Library failed to start')); }, 30000);
    globalThis[key] = () => { clearTimeout(timer); delete globalThis[key]; resolve(); };
    const s = document.createElement('script');
    if (isModule) s.type = 'module';
    s.textContent = code + `\n;globalThis[${JSON.stringify(key)}]&&globalThis[${JSON.stringify(key)}]();`;
    document.head.appendChild(s);
  });
}

let pdfjsPromise = null;
function loadPdfJs() {
  return pdfjsPromise || (pdfjsPromise = (async () => {
    await injectScript(await unpackText('lib-pdfjs'), true);
    const lib = globalThis.pdfjsLib;
    if (!lib) throw new Error('PDF engine failed to load');
    const workerCode = await unpackText('lib-pdfjs-worker'); // classic script (converted at build time)
    let ok = false;
    try {
      const url = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
      const w = new Worker(url); // classic blob workers are allowed even on file:// pages
      ok = await new Promise(res => {
        const t = setTimeout(() => res(false), 10000);
        w.addEventListener('message', () => { clearTimeout(t); res(true); }, { once: true });
        w.addEventListener('error', ev => { ev.preventDefault?.(); clearTimeout(t); res(false); }, { once: true });
      });
      if (ok) lib.GlobalWorkerOptions.workerPort = w; else w.terminate();
    } catch { ok = false; }
    if (!ok) await injectScript(workerCode, false); // main-thread fallback (sets globalThis.pdfjsWorker)
    return lib;
  })().catch(err => { pdfjsPromise = null; throw err; }));
}

let dataPack = null;
async function getDataPack() {
  if (dataPack) return dataPack;
  const u8 = await unpack('lib-pdfdata');
  const hdrLen = new DataView(u8.buffer, u8.byteOffset, 4).getUint32(0, true);
  const index = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + hdrLen)));
  return (dataPack = { u8, index, base: 4 + hdrLen });
}
/* Serves CMaps, standard fonts and WASM decoders to PDF.js from the embedded pack. */
class EmbeddedDataFactory {
  constructor() {}
  async fetch({ filename }) {
    const { u8, index, base } = await getDataPack();
    const e = index[filename];
    if (!e) throw new Error('Embedded resource not available: ' + filename);
    return u8.slice(base + e[0], base + e[0] + e[1]);
  }
}

let pdfLibCode = null;
const getPdfLibCode = async () => pdfLibCode || (pdfLibCode = await unpackText('lib-pdflib'));
async function loadPdfLibMain() {
  if (!globalThis.PDFLib) await injectScript(await getPdfLibCode(), false);
  return globalThis.PDFLib;
}

/* ---------------------------------------------------------------- state */
const S = {
  docId: 0, pdf: null, file: null, pages: [], items: [], sel: null, editing: null,
  scale: 1, fit: 'auto', cur: 1, hist: [], fut: [], dirty: false, sigs: [], lastBlob: null, lastName: '',
  rec: null,        // the stored document record (null when "keep documents" is off)
  saveFailed: false,
};
const itemEls = new Map();

const app = $('#app'), scroller = $('#scroller'), pagesEl = $('#pages'), thumbsEl = $('#thumbs');
const thumbsPanel = $('#thumbsPanel'), pdfInput = $('#pdfInput');
const pageInput = $('#pageInput'), pageTotal = $('#pageTotal'), zoomLabel = $('#zoomLabel');
const undoBtn = $('#undoBtn'), redoBtn = $('#redoBtn');

const getItem = id => S.items.find(i => i.id === id) || null;
const pageOf = it => S.pages[it.page - 1];

/* ---------------------------------------------------------------- toasts / modals */
function toast(msg, kind = 'info', ms = 3200, action) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const span = document.createElement('span'); span.textContent = msg; t.append(span);
  if (action) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = action.label;
    b.onclick = () => { action.run(); t.remove(); }; t.append(b);
  }
  $('#toasts').append(t);
  setTimeout(() => { t.style.transition = 'opacity .25s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 260); }, ms);
}

const modalStack = [];
function openModal(html, { cls = '', dismissible = true, onClose } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  const m = back.firstElementChild;
  const prevFocus = document.activeElement;
  const entry = { back, m, dismissible, close(result) {
    const i = modalStack.indexOf(entry); if (i < 0) return;
    modalStack.splice(i, 1); back.remove();
    try { prevFocus?.focus?.({ preventScroll: true }); } catch {}
    onClose && onClose(result);
  } };
  back.addEventListener('pointerdown', e => { if (e.target === back && entry.dismissible) entry.close(); });
  m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => entry.close()));
  document.body.append(back);
  modalStack.push(entry);
  requestAnimationFrame(() => {
    const f = m.querySelector('[autofocus]') || m.querySelector('input:not([type=hidden]),button.primary,button');
    f?.focus({ preventScroll: true });
  });
  return entry;
}
const topModal = () => modalStack[modalStack.length - 1];

function confirmModal({ title, body, ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    let done = false;
    const md = openModal(`
      <div class="modal-head"><h2></h2></div>
      <div class="modal-body"></div>
      <div class="modal-foot"><button class="btn" type="button" data-act="no"></button><button class="btn ${danger ? 'danger' : 'primary'}" type="button" data-act="yes" autofocus></button></div>`,
      { onClose: () => { if (!done) resolve(false); } });
    md.m.querySelector('h2').textContent = title;
    md.m.querySelector('.modal-body').textContent = body;
    const yes = md.m.querySelector('[data-act=yes]'), no = md.m.querySelector('[data-act=no]');
    yes.textContent = ok; no.textContent = cancel;
    yes.onclick = () => { done = true; resolve(true); md.close(); };
    no.onclick = () => { done = true; resolve(false); md.close(); };
  });
}

let busyEl = null;
function showBusy(text, sub = '', progress = null) {
  if (!busyEl) {
    busyEl = document.createElement('div');
    busyEl.className = 'busy';
    busyEl.innerHTML = '<div class="busy-card" role="status"><div class="spinner"></div><div class="busy-text"></div><div class="busy-sub"></div><div class="progress" hidden><i></i></div></div>';
    document.body.append(busyEl);
  }
  busyEl.querySelector('.busy-text').textContent = text;
  busyEl.querySelector('.busy-sub').textContent = sub;
  setBusyProgress(progress);
}
function setBusyProgress(v) {
  if (!busyEl) return;
  const bar = busyEl.querySelector('.progress');
  bar.hidden = v == null;
  if (v != null) bar.firstElementChild.style.width = Math.round(clamp(v, 0, 1) * 100) + '%';
}
function hideBusy() { busyEl?.remove(); busyEl = null; }

/* ---------------------------------------------------------------- local database (IndexedDB)
   Everything is stored only in this browser on this device:
     docs   – one record per PDF: name, hash, thumbnail, placed items (autosaved)
     files  – original PDF bytes (Blob), keyed by doc id
     signed – every signed copy that was downloaded (Blob), indexed by doc id
     sigs   – the signature library
     kv     – small values, e.g. the session to restore after a refresh            */
const DB = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { reject(new Error('IndexedDB is not available')); return; }
    const r = indexedDB.open('private-pdf-signer', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('docs', { keyPath: 'id' }).createIndex('hash', 'hash');
      db.createObjectStore('files');
      db.createObjectStore('signed', { keyPath: 'id' }).createIndex('docId', 'docId');
      db.createObjectStore('sigs', { keyPath: 'id' });
      db.createObjectStore('kv');
    };
    r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); dbp = null; }; resolve(db); };
    r.onerror = () => reject(r.error || new Error('Database could not be opened'));
    r.onblocked = () => reject(new Error('Database is blocked by another tab'));
  }).catch(err => { dbp = null; throw err; }));
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error || new Error('Storage transaction failed')); });
  return {
    open,
    async get(store, key) { const db = await open(); return req(db.transaction(store).objectStore(store).get(key)); },
    async all(store) { const db = await open(); return req(db.transaction(store).objectStore(store).getAll()); },
    async byIndex(store, index, value) { const db = await open(); return req(db.transaction(store).objectStore(store).index(index).getAll(value)); },
    async put(store, value, key) { const db = await open(); const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(value, key); return done(t); },
    async del(store, key) { const db = await open(); const t = db.transaction(store, 'readwrite'); t.objectStore(store).delete(key); return done(t); },
    async putDoc(rec, blob) { // record + original file in one atomic step
      const db = await open(); const t = db.transaction(['docs', 'files'], 'readwrite');
      t.objectStore('docs').put(rec); if (blob) t.objectStore('files').put(blob, rec.id); return done(t);
    },
    async deleteDoc(id) {
      const db = await open(); const t = db.transaction(['docs', 'files', 'signed'], 'readwrite');
      t.objectStore('docs').delete(id); t.objectStore('files').delete(id);
      const idx = t.objectStore('signed').index('docId');
      idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = e => { const c = e.target.result; if (c) { t.objectStore('signed').delete(c.primaryKey); c.continue(); } };
      return done(t);
    },
    async clearAll() {
      const db = await open(); const names = ['docs', 'files', 'signed', 'sigs', 'kv'];
      const t = db.transaction(names, 'readwrite'); names.forEach(n => t.objectStore(n).clear()); return done(t);
    },
  };
})();
const LS_KEEP = 'pdfsigner.v2.keepDocs';
const keepDocs = () => { try { return localStorage.getItem(LS_KEEP) !== '0'; } catch { return true; } };
let storageWarned = false;
function storageError(err) {
  console.warn('Storage error', err);
  S.saveFailed = true;
  if (storageWarned) return;
  storageWarned = true;
  const full = /quota/i.test(err?.name + ' ' + err?.message);
  toast(full ? 'This device’s browser storage is full. Your work continues, but it can’t be saved for later. Free space in “My documents”.'
             : 'This browser can’t save data (for example, in private mode). Your work continues, but it won’t survive a refresh.', 'error', 7000);
}
let persistAsked = false;
function askPersistentStorage() { // protects saved documents from automatic browser clean-up
  if (persistAsked) return; persistAsked = true;
  try { navigator.storage?.persist?.().catch(() => {}); } catch {}
}

/* ---------------------------------------------------------------- saved signatures */
const LS_SIGS = 'pdfsigner.v2.signatures', LS_NAME = 'pdfsigner.v2.name';
const isImgData = s => typeof s === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(s);
async function loadSigs() {
  let stored = [];
  try { stored = (await DB.all('sigs')).filter(s => s && isImgData(s.src)).sort((a, b) => (b.t || 0) - (a.t || 0)); }
  catch (err) { storageError(err); }
  S.sigs = stored.map(s => ({ id: s.id, src: s.src, t: s.t, saved: true })).concat(S.sigs.filter(s => !s.saved));
  // migrate signatures kept in localStorage by earlier versions of this tool
  const legacy = [];
  try { const a = JSON.parse(localStorage.getItem(LS_SIGS) || '[]'); if (Array.isArray(a)) legacy.push(...a.map(s => s?.src)); } catch {}
  try { const a = JSON.parse(localStorage.getItem('pdfSigner.signatures') || '[]'); if (Array.isArray(a)) legacy.push(...a); } catch {}
  let migrated = 0;
  for (const src of legacy) {
    if (!isImgData(src) || S.sigs.some(s => s.src === src)) continue;
    const sig = { id: uid(), src, t: Date.now() - migrated, saved: true };
    try { await DB.put('sigs', { id: sig.id, src: sig.src, t: sig.t }); S.sigs.push(sig); migrated++; } catch (err) { storageError(err); break; }
  }
  if (legacy.length && !S.saveFailed) { try { localStorage.removeItem(LS_SIGS); localStorage.removeItem('pdfSigner.signatures'); } catch {} }
  renderSigLists();
}
function addSignature(src, remember) {
  const existing = S.sigs.find(s => s.src === src);
  if (existing) return existing;
  const sig = { id: uid(), src, t: Date.now(), saved: !!remember };
  S.sigs.unshift(sig);
  if (remember) {
    askPersistentStorage();
    DB.put('sigs', { id: sig.id, src: sig.src, t: sig.t }).catch(err => {
      sig.saved = false; renderSigLists(); storageError(err);
    });
  }
  renderSigLists();
  return sig;
}
async function deleteSig(id) {
  const ok = await confirmModal({ title: 'Delete saved signature?', body: 'It will be removed from this device. Signatures already placed on documents are not affected.', ok: 'Delete', danger: true });
  if (!ok) return;
  const sig = S.sigs.find(s => s.id === id);
  S.sigs = S.sigs.filter(s => s.id !== id);
  if (sig?.saved) await DB.del('sigs', id).catch(storageError);
  renderSigLists();
  toast('Signature deleted.');
}
function renderSigLists() {
  for (const box of [$('#sigList'), $('#sigListSheet')]) {
    box.replaceChildren();
    if (!S.sigs.length) {
      const e = document.createElement('div'); e.className = 'sig-empty';
      e.textContent = 'No signatures yet. Create one by drawing, typing your name or uploading an image.';
      box.append(e); continue;
    }
    for (const s of S.sigs) {
      const card = document.createElement('div');
      card.className = 'sig-card'; card.tabIndex = 0; card.setAttribute('role', 'button');
      card.title = 'Click to add to the current page, or drag onto any page';
      card.setAttribute('aria-label', 'Add saved signature to the document');
      const img = new Image(); img.src = s.src; img.alt = ''; img.draggable = false;
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'sig-del'; del.innerHTML = ICON.x; del.title = 'Delete signature'; del.setAttribute('aria-label', 'Delete signature');
      del.addEventListener('click', e => { e.stopPropagation(); deleteSig(s.id); });
      card.append(img, del);
      if (!s.saved) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'This session only'; card.append(tag); }
      bindSource(card, () => ({ type: 'sig', src: s.src }));
      box.append(card);
    }
  }
}

/* ---------------------------------------------------------------- history */
const snapshot = () => S.items.map(o => ({ ...o }));
function pushHist(snap) {
  S.hist.push(snap); if (S.hist.length > 200) S.hist.shift();
  S.fut.length = 0; updateUndoUI();
}
function markDirty() { S.dirty = true; scheduleSave(); }

/* ---------------------------------------------------------------- autosave of the open document */
let saveTimer = 0, saving = Promise.resolve();
function scheduleSave(delay = 450) {
  if (!S.rec || !keepDocs()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delay);
}
function serializeItems() { // signature images are stored once per document, items reference them by index
  const srcs = [], index = new Map();
  const items = [];
  for (const it of S.items) {
    if (it.type === 'text' && !it.text.trim()) continue;
    const o = { ...it }; delete o._new;
    if (o.src) { let i = index.get(o.src); if (i == null) { i = srcs.length; srcs.push(o.src); index.set(o.src, i); } delete o.src; o.s = i; }
    items.push(o);
  }
  return { items, srcs };
}
function deserializeItems(rec, pageCount) {
  return (rec?.items || []).map(o => {
    const it = { ...o };
    if (it.s != null) { it.src = rec.srcs?.[it.s]; delete it.s; }
    return it;
  }).filter(it => it.page >= 1 && it.page <= pageCount && it.w > 0 && it.h > 0 &&
    (it.type === 'image' ? isImgData(it.src) : it.type === 'text' && typeof it.text === 'string' && it.text.trim()));
}
function saveNow() {
  clearTimeout(saveTimer);
  if (!S.rec || !keepDocs()) return saving;
  const { items, srcs } = serializeItems();
  const rec = { ...S.rec, items, srcs, updatedAt: Date.now() };
  S.rec = rec;
  saving = saving.then(() => DB.put('docs', rec)).then(() => { S.saveFailed = false; }).catch(storageError);
  return saving;
}
let sessionTimer = 0;
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    if (!keepDocs()) return;
    DB.put('kv', S.rec ? { docId: S.rec.id, page: S.cur } : null, 'session').catch(() => {});
  }, 300);
}
function updateUndoUI() { undoBtn.disabled = !S.hist.length; redoBtn.disabled = !S.fut.length; }
function restore(snap) {
  S.items = snap.map(o => ({ ...o }));
  const ids = new Set(S.items.map(i => i.id));
  for (const [id, el] of itemEls) if (!ids.has(id)) { el.remove(); itemEls.delete(id); }
  S.items.forEach(it => itemEl(it));
  if (!ids.has(S.sel)) S.sel = null;
  refreshSelection(); markDirty(); updateBadges();
}
function undo() { finishEdit(); if (!S.hist.length) return; S.fut.push(snapshot()); restore(S.hist.pop()); updateUndoUI(); }
function redo() { finishEdit(); if (!S.fut.length) return; S.hist.push(snapshot()); restore(S.fut.pop()); updateUndoUI(); }

/* ---------------------------------------------------------------- text metrics */
const mctx = document.createElement('canvas').getContext('2d');
function textMetrics(it) {
  const B = 100; // measure at 100px, scale linearly
  mctx.font = fontCss(it.font, B);
  const m = mctx.measureText(it.text || ' ');
  const fA = m.fontBoundingBoxAscent ?? B * 0.92, fD = m.fontBoundingBoxDescent ?? B * 0.24;
  const left = Math.max(0, m.actualBoundingBoxLeft || 0);
  const right = Math.max(m.width, m.actualBoundingBoxRight || 0);
  // Some (script) fonts draw outside their declared line box. Pad equally above and below so that
  // CSS (which centres the font box inside the line height) and the canvas export share one baseline.
  const vpad = Math.max(0, (m.actualBoundingBoxAscent || 0) - fA, (m.actualBoundingBoxDescent || 0) - fD) + B * 0.06;
  const pad = B * 0.08, k = it.size / B;
  return { w: (left + right + pad * 2) * k, h: (fA + fD + vpad * 2) * k, padL: (pad + left) * k, asc: (vpad + fA) * k };
}
function fitText(it) { const m = textMetrics(it); it.w = m.w; it.h = m.h; }
function fmtDate(d = new Date()) {
  try { return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return d.toISOString().slice(0, 10); }
}

/* ---------------------------------------------------------------- items: DOM */
function itemEl(it) {
  let el = itemEls.get(it.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'item item-' + it.type;
    el.dataset.id = it.id;
    if (it.type === 'image') {
      const img = new Image(); img.src = it.src; img.alt = 'Signature'; img.draggable = false; el.append(img);
    } else {
      const t = document.createElement('div');
      t.className = 'txt'; t.spellcheck = false; t.dataset.ph = 'Type here';
      t.setAttribute('autocapitalize', 'off'); t.setAttribute('autocorrect', 'off');
      bindTextEditor(t);
      el.append(t);
    }
    for (const h of ['nw', 'ne', 'sw', 'se']) {
      const hd = document.createElement('span'); hd.className = 'h h-' + h; hd.dataset.h = h; el.append(hd);
    }
    el.addEventListener('pointerdown', onItemPointerDown);
    el.addEventListener('dblclick', () => { const it2 = getItem(el.dataset.id); if (it2?.type === 'text') startEdit(it2); });
    itemEls.set(it.id, el);
  }
  const layer = pageOf(it).layer;
  if (el.parentNode !== layer) layer.append(el);
  layoutItem(it, el);
  return el;
}
function layoutItem(it, el = itemEls.get(it.id)) {
  if (!el) return;
  const s = S.scale;
  el.style.left = it.x * s + 'px'; el.style.top = it.y * s + 'px';
  el.style.width = it.w * s + 'px'; el.style.height = it.h * s + 'px';
  if (it.type === 'text') {
    const t = el.firstChild, m = textMetrics(it);
    if (S.editing !== it.id && t.textContent !== it.text) t.textContent = it.text;
    t.style.font = fontCss(it.font, it.size * s);
    t.style.lineHeight = it.h * s + 'px';
    t.style.paddingLeft = m.padL * s + 'px';
    t.style.color = it.color;
  }
  el.classList.toggle('selected', S.sel === it.id);
}
function layoutAllItems() { for (const it of S.items) layoutItem(it); }

function select(id) {
  if (S.editing && S.editing !== id) finishEdit();
  S.sel = id;
  refreshSelection();
}
function refreshSelection() {
  for (const [id, el] of itemEls) el.classList.toggle('selected', id === S.sel);
  renderItemBar();
}

/* ---------------------------------------------------------------- item bar */
const bar = document.createElement('div');
bar.className = 'itembar'; bar.hidden = true;
bar.addEventListener('pointerdown', e => e.stopPropagation());
let barFor = '';
function renderItemBar() {
  const it = getItem(S.sel);
  if (!it || S.dragging) { bar.hidden = true; return; }
  const sig = it.id + ':' + it.type;
  if (barFor !== sig) {
    barFor = sig;
    let html = '';
    if (it.type === 'text') {
      html += `<select data-act="font" aria-label="Font">${Object.entries(FONTS).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join('')}</select>
        <button type="button" data-act="smaller" title="Smaller text" aria-label="Smaller text">A−</button><span class="sz"></span>
        <button type="button" data-act="bigger" title="Bigger text" aria-label="Bigger text">A+</button>
        <label class="swatch" title="Text color"><i></i><input type="color" data-act="color" aria-label="Text color"></label>
        <button type="button" data-act="edit" title="Edit text (Enter)" aria-label="Edit text">${ICON.edit}</button><span class="sep"></span>`;
    }
    html += `<button type="button" data-act="dup" title="Duplicate (Ctrl+D)" aria-label="Duplicate">${ICON.copy}</button>
      <button type="button" data-act="all" title="Add a copy to every page" aria-label="Add to all pages">${ICON.pages}<span>All pages</span></button>
      <button type="button" data-act="del" class="danger" title="Delete (Del)" aria-label="Delete">${ICON.trash}</button>`;
    bar.innerHTML = html;
    bindItemBar();
  }
  if (it.type === 'text') {
    bar.querySelector('[data-act=font]').value = it.font;
    bar.querySelector('.sz').textContent = Math.round(it.size);
    bar.querySelector('.swatch i').style.background = it.color;
    bar.querySelector('[data-act=color]').value = it.color;
  }
  if (bar.parentNode !== pagesEl) pagesEl.append(bar);
  bar.hidden = false;
  positionItemBar();
}
function positionItemBar() {
  const it = getItem(S.sel);
  if (!it || bar.hidden) return;
  const p = pageOf(it), s = S.scale;
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  const pl = p.shell.offsetLeft, pt = p.shell.offsetTop;
  let left = pl + (it.x + it.w / 2) * s - bw / 2;
  left = clamp(left, 4, Math.max(4, pagesEl.scrollWidth - bw - 4));
  let top = pt + it.y * s - bh - 12;
  if (it.y * s - bh - 12 < -8) top = pt + (it.y + it.h) * s + 12;
  bar.style.left = left + 'px'; bar.style.top = top + 'px';
}
function bindItemBar() {
  bar.querySelectorAll('button[data-act]').forEach(b => b.addEventListener('click', () => {
    const it = getItem(S.sel); if (!it) return;
    const act = b.dataset.act;
    if (act === 'del') deleteItem(it.id);
    else if (act === 'dup') duplicateItem(it);
    else if (act === 'all') addToAllPages(it);
    else if (act === 'edit') startEdit(it);
    else if (act === 'smaller' || act === 'bigger') {
      finishEdit();
      const next = clamp(Math.round(it.size + (act === 'bigger' ? 1 : -1) * (it.size >= 24 ? 2 : 1)), 4, 200);
      if (next === it.size) return;
      pushHist(snapshot()); it.size = next; refit(it); markDirty();
    }
  }));
  const font = bar.querySelector('[data-act=font]');
  if (font) font.addEventListener('change', () => {
    const it = getItem(S.sel); if (!it) return;
    finishEdit(); pushHist(snapshot()); it.font = font.value; refit(it); markDirty();
  });
  const color = bar.querySelector('[data-act=color]');
  if (color) {
    let snap = null;
    color.addEventListener('click', () => { snap = snapshot(); });
    color.addEventListener('input', () => {
      const it = getItem(S.sel); if (!it) return;
      if (!snap) snap = snapshot();
      it.color = color.value; layoutItem(it); bar.querySelector('.swatch i').style.background = it.color;
    });
    color.addEventListener('change', () => { if (snap) { pushHist(snap); snap = null; markDirty(); } });
  }
}
function refit(it) { // text size/font changed: keep top-left, re-measure, keep inside page
  fitText(it); const p = pageOf(it);
  if (it.w > p.w) { it.size *= p.w / it.w * 0.98; fitText(it); }
  it.x = clamp(it.x, 0, Math.max(0, p.w - it.w)); it.y = clamp(it.y, 0, Math.max(0, p.h - it.h));
  layoutItem(it); renderItemBar();
}

/* ---------------------------------------------------------------- item ops */
function addItem(it, { selectIt = true } = {}) {
  S.items.push(it); itemEl(it);
  if (selectIt) select(it.id);
  markDirty(); updateBadges();
}
function deleteItem(id) {
  const it = getItem(id); if (!it) return;
  if (S.editing === id) { S.editing = null; }
  pushHist(snapshot());
  S.items = S.items.filter(i => i.id !== id);
  itemEls.get(id)?.remove(); itemEls.delete(id);
  if (S.sel === id) S.sel = null;
  refreshSelection(); markDirty(); updateBadges();
}
function duplicateItem(it) {
  finishEdit();
  const p = pageOf(it);
  const copy = { ...it, id: uid() }; delete copy._new;
  copy.x = it.x + 14 + it.w > p.w ? Math.max(0, it.x - 14) : it.x + 14;
  copy.y = it.y + 14 + it.h > p.h ? Math.max(0, it.y - 14) : it.y + 14;
  pushHist(snapshot()); addItem(copy);
}
async function addToAllPages(it) {
  finishEdit();
  if (S.pages.length < 2) { toast('This document has only one page.'); return; }
  const ok = await confirmModal({ title: 'Add to every page?', body: `A copy will be placed at the same position on all ${S.pages.length} pages. You can still move or delete each copy afterwards.`, ok: 'Add to all pages' });
  if (!ok) return;
  pushHist(snapshot());
  const src = pageOf(it);
  for (const p of S.pages) {
    if (p.num === it.page) continue;
    const c = { ...it, id: uid(), page: p.num }; delete c._new;
    const f = Math.min(1, p.w / c.w, p.h / c.h);
    if (f < 1) { c.w *= f; c.h *= f; if (c.type === 'text') { c.size *= f; fitText(c); } }
    // keep the same distance from the nearest edges so footers/headers line up on differently sized pages
    c.x = it.x + it.w / 2 > src.w / 2 ? p.w - (src.w - it.x - it.w) - c.w : it.x;
    c.y = it.y + it.h / 2 > src.h / 2 ? p.h - (src.h - it.y - it.h) - c.h : it.y;
    c.x = clamp(c.x, 0, Math.max(0, p.w - c.w)); c.y = clamp(c.y, 0, Math.max(0, p.h - c.h));
    S.items.push(c); itemEl(c);
  }
  markDirty(); updateBadges(); refreshSelection();
  toast(`Added to ${S.pages.length - 1} more page${S.pages.length > 2 ? 's' : ''}.`, 'success');
}

/* ---------------------------------------------------------------- text editing */
let editSnap = null, editOrig = '';
function bindTextEditor(t) {
  t.addEventListener('input', () => {
    const it = getItem(S.editing); if (!it || itemEls.get(it.id)?.firstChild !== t) return;
    it.text = t.textContent.replace(/[\r\n]+/g, ' ');
    fitText(it);
    const p = pageOf(it);
    if (it.x + it.w > p.w) it.x = Math.max(0, p.w - it.w);
    layoutItem(it); positionItemBar(); scheduleSave(800);
  });
  t.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finishEdit(); }
    else if (e.key === 'Escape') { e.preventDefault(); finishEdit(true); }
    e.stopPropagation();
  });
  t.addEventListener('paste', e => {
    e.preventDefault();
    const text = (e.clipboardData?.getData('text/plain') || '').replace(/[\r\n\t]+/g, ' ');
    if (!document.execCommand('insertText', false, text)) {
      const sel = getSelection(); if (!sel.rangeCount) return;
      sel.deleteFromDocument(); sel.getRangeAt(0).insertNode(document.createTextNode(text)); sel.collapseToEnd();
      t.dispatchEvent(new Event('input'));
    }
  });
  t.addEventListener('drop', e => e.preventDefault());
  t.addEventListener('blur', () => { if (S.editing && itemEls.get(S.editing)?.firstChild === t) finishEdit(); });
}
function startEdit(it) {
  if (!it || it.type !== 'text') return;
  if (S.editing === it.id) return;
  finishEdit();
  select(it.id);
  const el = itemEls.get(it.id), t = el.firstChild;
  S.editing = it.id; editSnap = snapshot(); editOrig = it.text;
  el.classList.add('editing');
  t.contentEditable = 'true';
  t.focus({ preventScroll: true });
  const r = document.createRange(); r.selectNodeContents(t);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  renderItemBar();
}
function finishEdit(revert = false) {
  const id = S.editing; if (!id) return;
  S.editing = null;
  const it = getItem(id), el = itemEls.get(id);
  if (el) { el.classList.remove('editing'); el.firstChild.contentEditable = 'false'; }
  getSelection()?.removeAllRanges();
  if (!it) return;
  if (revert) { it.text = editOrig; fitText(it); }
  it.text = it.text.trim() ? it.text : '';
  if (!it.text) {
    // empty text: remove it; a brand-new field leaves no trace in history
    if (it._new) { S.hist.pop(); updateUndoUI(); } else pushHist(editSnap);
    S.items = S.items.filter(i => i.id !== id); el?.remove(); itemEls.delete(id);
    if (S.sel === id) S.sel = null;
    refreshSelection(); updateBadges(); return;
  }
  if (!it._new && it.text !== editOrig) { pushHist(editSnap); markDirty(); }
  delete it._new;
  fitText(it); layoutItem(it); renderItemBar();
}

/* ---------------------------------------------------------------- pointer gestures on items */
function pageAtPoint(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.classList?.contains('page')) return S.pages[+el.dataset.p - 1] || null;
  }
  return null;
}
const autoScroll = {
  raf: 0, vx: 0, vy: 0, cb: null,
  update(x, y, cb) {
    const r = scroller.getBoundingClientRect(), E = 56;
    let vy = 0, vx = 0;
    if (y < r.top + E) vy = -(r.top + E - y); else if (y > r.bottom - E) vy = y - (r.bottom - E);
    if (x < r.left + E) vx = -(r.left + E - x); else if (x > r.right - E) vx = x - (r.right - E);
    this.vx = clamp(vx, -E, E) * 0.4; this.vy = clamp(vy, -E, E) * 0.4; this.cb = cb;
    if ((this.vx || this.vy) && !this.raf) this.loop();
  },
  loop() {
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (!this.vx && !this.vy) return;
      const t0 = scroller.scrollTop, l0 = scroller.scrollLeft;
      scroller.scrollTop += this.vy; scroller.scrollLeft += this.vx;
      if (scroller.scrollTop !== t0 || scroller.scrollLeft !== l0) this.cb && this.cb();
      this.loop();
    });
  },
  stop() { this.vx = this.vy = 0; cancelAnimationFrame(this.raf); this.raf = 0; this.cb = null; },
};

function onItemPointerDown(e) {
  const el = e.currentTarget, it = getItem(el.dataset.id);
  if (!it) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const handle = e.target.dataset?.h;
  if (S.editing === it.id && !handle) return; // let the caret move inside the text
  if (S.editing && S.editing !== it.id) finishEdit();
  e.preventDefault(); e.stopPropagation();
  const wasSelected = S.sel === it.id;
  select(it.id);
  if (!getItem(it.id)) return; // finishing an edit may have removed it
  startGesture(e, it, handle ? 'resize' : 'move', handle, wasSelected, el);
}

function startGesture(e, it, mode, handle, wasSelected, el) {
  try { el.setPointerCapture(e.pointerId); } catch {}
  const p0 = pageOf(it), r0 = p0.shell.getBoundingClientRect();
  const g = {
    pid: e.pointerId, it, mode, handle, moved: false, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY,
    snap: snapshot(), start: { x: it.x, y: it.y, w: it.w, h: it.h, size: it.size },
    grabX: (e.clientX - r0.left) / S.scale - it.x, grabY: (e.clientY - r0.top) / S.scale - it.y,
  };
  const apply = () => (mode === 'move' ? doMove(g) : doResize(g));
  const move = ev => {
    if (ev.pointerId !== g.pid) return;
    g.lx = ev.clientX; g.ly = ev.clientY;
    if (!g.moved) {
      if (Math.hypot(ev.clientX - g.sx, ev.clientY - g.sy) < (ev.pointerType === 'touch' ? 6 : 3)) return;
      g.moved = true; S.dragging = true; el.classList.add('dragging'); bar.hidden = true;
    }
    apply();
    autoScroll.update(ev.clientX, ev.clientY, apply);
  };
  const up = ev => {
    if (ev.pointerId !== g.pid) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    autoScroll.stop();
    S.dragging = false; el.classList.remove('dragging');
    document.querySelectorAll('.page.drop-target').forEach(n => n.classList.remove('drop-target'));
    if (g.moved) { pushHist(g.snap); markDirty(); updateBadges(); }
    else if (mode === 'move' && wasSelected && it.type === 'text' && ev.type === 'pointerup') { startEdit(it); return; }
    renderItemBar();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function doMove(g) {
  const it = g.it;
  let p = pageAtPoint(g.lx, g.ly) || pageOf(it);
  const r = p.shell.getBoundingClientRect();
  if (p.num !== it.page) {
    // moved onto another page; shrink if it does not fit there
    const f = Math.min(1, p.w / it.w, p.h / it.h);
    if (f < 1) { it.w *= f; it.h *= f; if (it.type === 'text') { it.size *= f; fitText(it); } g.grabX *= f; g.grabY *= f; }
    it.page = p.num; p.layer.append(itemEls.get(it.id));
  }
  it.x = clamp((g.lx - r.left) / S.scale - g.grabX, 0, Math.max(0, p.w - it.w));
  it.y = clamp((g.ly - r.top) / S.scale - g.grabY, 0, Math.max(0, p.h - it.h));
  layoutItem(it);
}

function doResize(g) {
  const it = g.it, p = pageOf(it), r = p.shell.getBoundingClientRect(), s = g.start, h = g.handle;
  const east = h.includes('e'), south = h.includes('s');
  const ax = east ? s.x : s.x + s.w, ay = south ? s.y : s.y + s.h; // fixed corner
  const px = (g.lx - r.left) / S.scale, py = (g.ly - r.top) / S.scale;
  const dx = east ? px - ax : ax - px, dy = south ? py - ay : ay - py;
  let f = (dx * s.w + dy * s.h) / (s.w * s.w + s.h * s.h); // project pointer onto the diagonal
  const minW = it.type === 'text' ? s.w * (4 / s.size) : 12;
  const maxF = Math.min((east ? p.w - ax : ax) / s.w, (south ? p.h - ay : ay) / s.h);
  f = clamp(f, Math.min(minW / s.w, maxF), maxF);
  if (it.type === 'text') { it.size = s.size * f; fitText(it); } else { it.w = s.w * f; it.h = s.h * f; }
  it.x = east ? ax : ax - it.w; it.y = south ? ay : ay - it.h;
  it.x = clamp(it.x, 0, Math.max(0, p.w - it.w)); it.y = clamp(it.y, 0, Math.max(0, p.h - it.h));
  layoutItem(it);
}

/* ---------------------------------------------------------------- placing new items */
const imgDimsCache = new Map();
function imgDims(src) {
  if (imgDimsCache.has(src)) return Promise.resolve(imgDimsCache.get(src));
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => { const d = { w: im.naturalWidth || 300, h: im.naturalHeight || 100 }; imgDimsCache.set(src, d); res(d); };
    im.onerror = () => rej(new Error('Image could not be read'));
    im.src = src;
  });
}
function viewCenter() {
  const p = S.pages[S.cur - 1] || S.pages[0];
  const r = p.shell.getBoundingClientRect(), v = scroller.getBoundingClientRect();
  const top = Math.max(r.top, v.top), bottom = Math.min(r.bottom, v.bottom);
  const left = Math.max(r.left, v.left), right = Math.min(r.right, v.right);
  if (bottom <= top || right <= left) return { page: p, x: p.w / 2, y: p.h / 2 };
  return { page: p, x: ((left + right) / 2 - r.left) / S.scale, y: ((top + bottom) / 2 - r.top) / S.scale };
}
function defaultSigSize(p, d) {
  let w = Math.min(170, p.w * 0.36), h = w * d.h / d.w;
  if (h > p.h * 0.22) { h = p.h * 0.22; w = h * d.w / d.h; }
  return { w, h };
}
async function placePayload(pl, page, cx, cy) {
  if (!S.pdf) { toast('Open a PDF first.'); return; }
  finishEdit();
  const autoPlaced = !page;
  if (!page) { const c = viewCenter(); page = c.page; cx = c.x; cy = c.y; }
  let it;
  if (pl.type === 'sig') {
    let d; try { d = await imgDims(pl.src); } catch { toast('This signature image could not be read.', 'error'); return; }
    const { w, h } = defaultSigSize(page, d);
    it = { id: uid(), type: 'image', page: page.num, src: pl.src, w, h, x: 0, y: 0 };
  } else {
    const isDate = pl.type === 'date';
    it = { id: uid(), type: 'text', page: page.num, text: isDate ? fmtDate() : '', font: 'sans', size: isDate ? 12 : 14, color: '#111827', x: 0, y: 0 };
    fitText(it);
    if (!isDate) it.w = Math.max(it.w, 64);
  }
  it.x = clamp(cx - it.w / 2, 0, Math.max(0, page.w - it.w));
  it.y = clamp(cy - it.h / 2, 0, Math.max(0, page.h - it.h));
  if (autoPlaced) { // don't stack a click-added item exactly on top of another one
    for (let guard = 0; guard < 50; guard++) {
      const hit = S.items.find(o => o.page === page.num && it.x < o.x + o.w && it.x + it.w > o.x && it.y < o.y + o.h && it.y + it.h > o.y);
      if (!hit || hit.y + hit.h + 8 + it.h > page.h) break;
      it.y = hit.y + hit.h + 8;
    }
  }
  pushHist(snapshot());
  addItem(it);
  closeSheet();
  if (pl.type === 'text') { it._new = true; fitText(it); startEdit(it); }
  else if (isTouchUI()) toast(pl.type === 'sig' ? 'Signature added. Drag it into place, or use the corners to resize.' : 'Date added. Tap it again to edit.', 'info', 2600);
}

let suppressClickUntil = 0;
function bindSource(el, getPayload) {
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.pointerType === 'touch' || e.target.closest('.sig-del')) return;
    const pl = getPayload(); if (!pl) return;
    e.preventDefault();
    const st = { x: e.clientX, y: e.clientY, pid: e.pointerId, ghost: null, target: null };
    const highlight = p => {
      if (st.target === p) return;
      st.target?.shell.classList.remove('drop-target'); st.target = p; p?.shell.classList.add('drop-target');
    };
    const move = ev => {
      if (ev.pointerId !== st.pid) return;
      if (!st.ghost) {
        if (Math.hypot(ev.clientX - st.x, ev.clientY - st.y) < 5 || !S.pdf) return;
        st.ghost = makeGhost(pl); document.body.classList.add('is-dragging');
      }
      st.ghost.style.left = ev.clientX + 'px'; st.ghost.style.top = ev.clientY + 'px';
      highlight(pageAtPoint(ev.clientX, ev.clientY));
      autoScroll.update(ev.clientX, ev.clientY, () => highlight(pageAtPoint(ev.clientX, ev.clientY)));
    };
    const up = ev => {
      if (ev.pointerId !== st.pid) return;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      autoScroll.stop(); highlight(null);
      if (!st.ghost) return;
      st.ghost.remove(); document.body.classList.remove('is-dragging');
      suppressClickUntil = performance.now() + 400;
      if (ev.type !== 'pointerup') return;
      const p = pageAtPoint(ev.clientX, ev.clientY);
      if (!p) { toast('Drop it onto a page to place it.'); return; }
      const r = p.shell.getBoundingClientRect();
      placePayload(pl, p, (ev.clientX - r.left) / S.scale, (ev.clientY - r.top) / S.scale);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  });
  el.addEventListener('click', e => {
    if (performance.now() < suppressClickUntil || e.target.closest('.sig-del')) return;
    const pl = getPayload(); if (pl) placePayload(pl);
  });
  el.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); const pl = getPayload(); if (pl) placePayload(pl); }
  });
}
function makeGhost(pl) {
  const g = document.createElement('div');
  if (pl.type === 'sig') {
    g.className = 'drag-ghost';
    const d = imgDimsCache.get(pl.src) || { w: 3, h: 1 };
    const p = S.pages[S.cur - 1];
    g.style.width = defaultSigSize(p, d).w * S.scale + 'px';
    const img = new Image(); img.src = pl.src; g.append(img);
    imgDims(pl.src).catch(() => {});
  } else {
    g.className = 'drag-ghost text-ghost';
    g.textContent = pl.type === 'date' ? fmtDate() : 'Text';
  }
  document.body.append(g);
  return g;
}

/* ---------------------------------------------------------------- open PDF */
function pickPdf() { pdfInput.value = ''; pdfInput.click(); }
function hasPdfHeader(u8) {
  for (let i = 0; i + 4 < u8.length; i++) if (u8[i] === 0x25 && u8[i + 1] === 0x50 && u8[i + 2] === 0x44 && u8[i + 3] === 0x46) return true;
  return false;
}
async function openPdfFile(file) {
  if (!file) return;
  const looksPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  let head;
  try { head = new Uint8Array(await file.slice(0, 1024).arrayBuffer()); } catch { toast('This file could not be read.', 'error'); return; }
  if (!hasPdfHeader(head)) { toast(looksPdf ? 'This file is damaged or is not a real PDF.' : 'Please choose a PDF file.', 'error', 4200); return; }
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { toast('This file could not be read.', 'error'); return; }
  return openBytes(file.name, bytes, null);
}
async function hashBytes(u8) {
  try {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', u8));
    return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
  } catch { // crypto.subtle is unavailable in some insecure contexts: FNV-1a fallback
    let h = 0x811c9dc5; for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193); }
    return 'fnv:' + u8.length + ':' + (h >>> 0).toString(16);
  }
}
async function pageThumb(p) {
  try {
    const vp = p.pg.getViewport({ scale: 140 / p.w });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await p.pg.render({ canvas: c, viewport: vp, background: '#ffffff' }).promise;
    const url = c.toDataURL('image/jpeg', 0.78); c.width = c.height = 0; return url;
  } catch { return ''; }
}
/** Opens PDF bytes. `rec` is the stored record when reopening a saved document. */
async function openBytes(name, bytes, rec, { page = 0, restoring = false } = {}) {
  if (S.pdf && !S.rec && S.dirty && S.items.length) { // only unsaved work can be lost
    const ok = await confirmModal({ title: 'Open a different PDF?', body: 'The signatures and fields you placed on the current document have not been downloaded and will be discarded.', ok: 'Discard and open', danger: true });
    if (!ok) return false;
  }
  finishEdit();
  await saveNow();
  showBusy(restoring ? 'Restoring your document…' : 'Opening PDF…', name);
  let cancelled = false, task = null, hash = rec?.hash || null;
  try {
    const lib = await loadPdfJs();
    if (!rec && keepDocs()) { // opened before? continue where the user left off
      hash = await hashBytes(bytes);
      try { rec = (await DB.byIndex('docs', 'hash', hash)).sort((a, b) => b.updatedAt - a.updatedAt)[0] || null; } catch (err) { storageError(err); }
    }
    task = lib.getDocument({
      data: bytes.slice(), BinaryDataFactory: EmbeddedDataFactory, useWorkerFetch: false,
      cMapUrl: 'embedded:/', cMapPacked: true, standardFontDataUrl: 'embedded:/', wasmUrl: 'embedded:/',
      // useSystemFonts:false → non-embedded standard fonts come from the bundled font data,
      // so every device renders the document identically and nothing is fetched.
      useSystemFonts: false, enableXfa: false, stopAtErrors: false,
    });
    let password = null;
    task.onPassword = (update, reason) => {
      hideBusy();
      askPassword(name, reason === lib.PasswordResponses.INCORRECT_PASSWORD).then(pw => {
        if (pw == null) { cancelled = true; task.destroy(); return; }
        password = pw; showBusy('Opening PDF…', name); update(pw);
      });
    };
    const pdf = await task.promise;
    const ok = await setDocument(pdf, { name, bytes, password, task }, rec);
    if (!ok) return false;
    await linkRecord(rec, name, bytes, hash);
    if (page > 1) { await nextFrame(); scrollToPage(page, true); }
    if (rec && !restoring && S.items.length) toast(`Welcome back. The ${S.items.length} item${S.items.length > 1 ? 's' : ''} you placed earlier on this document ${S.items.length > 1 ? 'were' : 'was'} restored.`, 'success', 5000);
    return true;
  } catch (err) {
    if (!cancelled) {
      console.error(err);
      toast(err?.name === 'InvalidPDFException' ? 'This PDF is damaged and cannot be opened.' : 'This PDF could not be opened. ' + (err?.message || ''), 'error', 5000);
    }
    return false;
  } finally { hideBusy(); }
}
/** Connects the open document to its stored record (creating one the first time). */
async function linkRecord(rec, name, bytes, hash) {
  if (!keepDocs()) { S.rec = null; return; }
  try {
    if (rec) {
      S.rec = { ...rec, name, pages: S.pages.length, openedAt: Date.now() };
      await DB.put('docs', S.rec);
    } else {
      const now = Date.now();
      S.rec = { id: uid(), hash: hash || await hashBytes(bytes), name, size: bytes.length, pages: S.pages.length,
        createdAt: now, updatedAt: now, openedAt: now, thumb: await pageThumb(S.pages[0]), items: [], srcs: [], signedCount: 0 };
      await DB.putDoc(S.rec, new Blob([bytes], { type: 'application/pdf' }));
      askPersistentStorage();
    }
    saveSession();
  } catch (err) { S.rec = null; storageError(err); }
}
async function openStoredDoc(id, opts = {}) {
  let rec, blob;
  try { [rec, blob] = await Promise.all([DB.get('docs', id), DB.get('files', id)]); } catch (err) { storageError(err); return false; }
  if (!rec || !blob) { toast('That document is no longer stored on this device.', 'error'); return false; }
  return openBytes(rec.name, new Uint8Array(await blob.arrayBuffer()), rec, opts);
}
function teardownDocument() {
  const oldTask = S.file?.task;
  pageObserver?.disconnect(); thumbObserver?.disconnect();
  for (const p of S.pages) { try { p.task?.cancel(); } catch {} clearTimeout(p.releaseTimer); if (p.canvas) p.canvas.width = p.canvas.height = 0; }
  pagesEl.replaceChildren(); thumbsEl.replaceChildren(); itemEls.clear(); barFor = ''; bar.hidden = true;
  T.queue.length = 0;
  if (oldTask) Promise.resolve().then(() => oldTask.destroy()).catch(() => {});
}
/** Closes the document and returns to the start screen (the work stays saved). */
async function goHome() {
  if (!S.pdf) return;
  finishEdit();
  if (!S.rec && S.dirty && S.items.length) {
    const ok = await confirmModal({ title: 'Close this document?', body: 'Saving documents on this device is turned off, so the items you placed will be discarded.', ok: 'Discard and close', danger: true });
    if (!ok) return;
  }
  await saveNow();
  S.docId++;
  teardownDocument();
  Object.assign(S, { pdf: null, file: null, pages: [], items: [], sel: null, editing: null, hist: [], fut: [], dirty: false, cur: 1, rec: null });
  updateUndoUI();
  app.dataset.view = 'landing';
  document.title = 'Private PDF Signer — sign PDFs offline';
  if (keepDocs()) DB.put('kv', null, 'session').catch(() => {});
  renderRecent();
}
function askPassword(name, wrong) {
  return new Promise(resolve => {
    let done = false;
    const md = openModal(`
      <div class="modal-head"><h2>Password required</h2></div>
      <form class="modal-body" autocomplete="off">
        <div></div>
        <label class="field"><input type="password" autocomplete="off" aria-label="PDF password" autofocus></label>
        ${wrong ? '<div class="err">Incorrect password. Please try again.</div>' : ''}
      </form>
      <div class="modal-foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" data-act="ok">Open</button></div>`,
      { onClose: () => { if (!done) resolve(null); } });
    md.m.querySelector('.modal-body > div').textContent = `“${name}” is protected. Enter its password to open it. The password stays on this device.`;
    const input = md.m.querySelector('input');
    const submit = () => { done = true; resolve(input.value); md.close(); };
    md.m.querySelector('[data-act=ok]').onclick = submit;
    md.m.querySelector('form').onsubmit = e => { e.preventDefault(); submit(); };
  });
}

let pageObserver = null, thumbObserver = null;
async function setDocument(pdf, file, rec = null) {
  const id = ++S.docId;
  const n = pdf.numPages;
  const pages = [];
  for (let i = 1; i <= n; i += 50) {
    const batch = [];
    for (let j = i; j <= Math.min(n, i + 49); j++) batch.push(pdf.getPage(j));
    const loaded = await Promise.all(batch);
    if (id !== S.docId) { file.task?.destroy().catch(() => {}); return false; }
    for (const pg of loaded) {
      const vp = pg.getViewport({ scale: 1 });
      pages.push({ num: pg.pageNumber, pg, vp, w: vp.width, h: vp.height, rotate: pg.rotate, shell: null, layer: null, canvas: null, rs: 0, task: null, near: false, thumb: null, thumbDone: false });
    }
    if (n > 50) setBusyProgress(pages.length / n);
  }
  teardownDocument(); // the previous document
  Object.assign(S, { pdf, file, pages, items: [], sel: null, editing: null, hist: [], fut: [], dirty: false, cur: 1, lastBlob: null, fit: 'auto', rec: null });
  updateUndoUI();

  const frag = document.createDocumentFragment(), tfrag = document.createDocumentFragment();
  for (const p of pages) {
    const shell = document.createElement('div');
    shell.className = 'page'; shell.dataset.p = p.num;
    const layer = document.createElement('div'); layer.className = 'layer';
    const num = document.createElement('div'); num.className = 'page-num'; num.textContent = `${p.num} / ${n}`;
    shell.append(layer, num);
    p.shell = shell; p.layer = layer;
    frag.append(shell);
    const tb = document.createElement('button');
    tb.type = 'button'; tb.className = 'thumb'; tb.dataset.p = p.num; tb.setAttribute('aria-label', 'Go to page ' + p.num);
    tb.innerHTML = `<div class="tc" style="aspect-ratio:${p.w} / ${p.h}"><span class="badge" hidden></span></div><span class="tn">${p.num}</span>`;
    tb.addEventListener('click', () => scrollToPage(p.num));
    p.thumb = tb; tfrag.append(tb);
  }
  pagesEl.append(frag); thumbsEl.append(tfrag);
  app.dataset.view = 'editor';
  const dn = $('#docName'); dn.textContent = file.name; dn.title = file.name;
  pageTotal.textContent = '/ ' + n;
  document.title = file.name + ' — Private PDF Signer';
  await nextFrame();
  S.scale = fitScale('auto');
  relayout();
  scroller.scrollTop = 0; scroller.scrollLeft = Math.max(0, (pagesEl.scrollWidth - scroller.clientWidth) / 2);
  pageObserver = new IntersectionObserver(onPagesIntersect, { root: scroller, rootMargin: '120% 40%' });
  thumbObserver = new IntersectionObserver(onThumbsIntersect, { root: thumbsPanel, rootMargin: '300px 0px' });
  for (const p of pages) { pageObserver.observe(p.shell); thumbObserver.observe(p.thumb); }
  if (rec) { // bring back the items saved for this document
    await fontsReady;
    const restored = deserializeItems(rec, n);
    if (restored.length) { S.items = restored; restored.forEach(it => itemEl(it)); }
  }
  updatePageUI(); updateBadges();
  if (!S.sigs.length && !S.items.length && !isTouchUI()) toast('Tip: create your signature in the left panel, then drag it onto the page.', 'info', 5000);
  return true;
}

/* ---------------------------------------------------------------- layout, zoom, rendering */
const ZMIN = 0.25, ZMAX = 5;
function padX() { return isTouchUI() ? 20 : 48; }
function fitScale(mode) {
  const maxW = Math.max(...S.pages.map(p => p.w));
  const fit = (scroller.clientWidth - padX()) / maxW;
  return clamp(mode === 'auto' ? Math.min(fit, isTouchUI() ? fit : 1.5) : fit, ZMIN, ZMAX);
}
function relayout() {
  const s = S.scale;
  for (const p of S.pages) { p.shell.style.width = p.w * s + 'px'; p.shell.style.height = p.h * s + 'px'; }
  layoutAllItems();
  zoomLabel.textContent = Math.round(s * 100) + '%';
  positionItemBar();
}
function pageAtContentY(y) {
  let lo = 0, hi = S.pages.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (S.pages[mid].shell.offsetTop <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return S.pages[ans];
}
function setScale(ns, anchor, fitMode = null) {
  if (!S.pdf) return;
  ns = clamp(ns, ZMIN, ZMAX);
  S.fit = fitMode;
  if (Math.abs(ns - S.scale) < 1e-4) { relayout(); return; }
  const sr = scroller.getBoundingClientRect();
  const ax = anchor ? anchor.x - sr.left : scroller.clientWidth / 2;
  const ay = anchor ? anchor.y - sr.top : scroller.clientHeight / 2;
  const p = pageAtContentY(scroller.scrollTop + ay);
  const fy = (scroller.scrollTop + ay - p.shell.offsetTop) / p.shell.offsetHeight;
  const fx = (scroller.scrollLeft + ax - p.shell.offsetLeft) / p.shell.offsetWidth;
  S.scale = ns;
  relayout();
  scroller.scrollTop = p.shell.offsetTop + fy * p.shell.offsetHeight - ay;
  scroller.scrollLeft = p.shell.offsetLeft + fx * p.shell.offsetWidth - ax;
  for (const pg of S.pages) if (pg.task) { try { pg.task.cancel(); } catch {} }
  requestRender(140);
}
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
function zoomStep(dir) {
  const s = S.scale;
  const next = dir > 0 ? ZOOM_STEPS.find(z => z > s + 0.01) : [...ZOOM_STEPS].reverse().find(z => z < s - 0.01);
  setScale(next ?? (dir > 0 ? ZMAX : ZMIN));
}

const R = { running: false, timer: 0 };
function requestRender(delay = 0) {
  clearTimeout(R.timer);
  R.timer = setTimeout(pumpRender, delay);
}
async function pumpRender() {
  if (R.running) return;
  R.running = true;
  const id = S.docId;
  try {
    for (;;) {
      if (id !== S.docId) break;
      let best = null, bd = Infinity;
      for (const p of S.pages) if (p.near && !p.task && Math.abs(p.rs - S.scale) > 1e-6) {
        const d = Math.abs(p.num - S.cur); if (d < bd) { bd = d; best = p; }
      }
      if (!best) break;
      await renderPage(best, id);
    }
  } finally { R.running = false; }
}
const maxCanvasPixels = () => (isTouchUI() ? 9e6 : 16e6);
async function renderPage(p, id) {
  const scale = S.scale;
  let k = scale * Math.min(window.devicePixelRatio || 1, 3);
  const area = p.w * p.h * k * k, max = maxCanvasPixels();
  if (area > max) k *= Math.sqrt(max / area);
  const vp = p.pg.getViewport({ scale: k });
  const c = document.createElement('canvas');
  c.className = 'pg'; c.width = Math.max(1, Math.floor(vp.width)); c.height = Math.max(1, Math.floor(vp.height));
  const task = p.pg.render({ canvas: c, viewport: vp, annotationMode: globalThis.pdfjsLib.AnnotationMode.ENABLE, background: '#ffffff' });
  p.task = task;
  try { await task.promise; }
  catch (err) {
    p.task = null; c.width = c.height = 0;
    if (err?.name === 'RenderingCancelledException') return;
    console.warn('Page render failed', p.num, err);
    p.rs = scale; p.shell.classList.add('ready', 'error');
    return;
  }
  p.task = null;
  if (id !== S.docId) { c.width = c.height = 0; return; }
  if (p.canvas) { p.canvas.replaceWith(c); p.canvas.width = p.canvas.height = 0; } else p.shell.prepend(c);
  p.canvas = c; p.rs = scale; p.shell.classList.add('ready'); p.shell.classList.remove('error');
  // keep memory bounded during fast scrolling: free the canvases farthest from the current page
  const live = S.pages.filter(q => q.canvas && !q.near);
  const budget = isTouchUI() ? 4 : 8;
  if (live.length > budget) {
    live.sort((a, b) => Math.abs(b.num - S.cur) - Math.abs(a.num - S.cur));
    for (const q of live.slice(0, live.length - budget)) { clearTimeout(q.releaseTimer); releasePage(q); }
  }
}
function releasePage(p) {
  if (p.near || !p.canvas) return;
  try { p.task?.cancel(); } catch {}
  p.canvas.width = p.canvas.height = 0; p.canvas.remove(); p.canvas = null; p.rs = 0;
  p.shell.classList.remove('ready');
}
function onPagesIntersect(entries) {
  let any = false;
  for (const e of entries) {
    const p = S.pages[+e.target.dataset.p - 1]; if (!p) continue;
    p.near = e.isIntersecting;
    clearTimeout(p.releaseTimer);
    if (p.near) any = true; else p.releaseTimer = setTimeout(() => releasePage(p), 2000);
  }
  if (any) requestRender(0);
}

const T = { queue: [], running: false };
function onThumbsIntersect(entries) {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const p = S.pages[+e.target.dataset.p - 1];
    if (p && !p.thumbDone && !T.queue.includes(p)) T.queue.push(p);
  }
  pumpThumbs();
}
async function pumpThumbs() {
  if (T.running) return;
  T.running = true;
  const id = S.docId;
  try {
    while (T.queue.length && id === S.docId) {
      const p = T.queue.shift(); if (p.thumbDone) continue;
      p.thumbDone = true;
      const k = (128 * Math.min(window.devicePixelRatio || 1, 2)) / p.w;
      const vp = p.pg.getViewport({ scale: k });
      const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      try {
        await p.pg.render({ canvas: c, viewport: vp, annotationMode: globalThis.pdfjsLib.AnnotationMode.ENABLE, background: '#ffffff' }).promise;
        if (id === S.docId) p.thumb.querySelector('.tc').prepend(c);
      } catch { p.thumbDone = false; }
    }
  } finally { T.running = false; if (T.queue.length && id === S.docId) pumpThumbs(); }
}
function updateBadges() {
  const counts = new Map();
  for (const it of S.items) counts.set(it.page, (counts.get(it.page) || 0) + 1);
  for (const p of S.pages) {
    const b = p.thumb?.querySelector('.badge'); if (!b) continue;
    const c = counts.get(p.num) || 0; b.hidden = !c; b.textContent = c;
  }
}

/* ---------------------------------------------------------------- navigation */
let scrollRaf = 0;
scroller.addEventListener('scroll', () => {
  if (scrollRaf || !S.pdf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const p = pageAtContentY(scroller.scrollTop + scroller.clientHeight * 0.35);
    if (p && p.num !== S.cur) { S.cur = p.num; updatePageUI(); }
  });
}, { passive: true });
function updatePageUI() {
  saveSession();
  if (document.activeElement !== pageInput) pageInput.value = S.cur;
  $('#prevBtn').disabled = S.cur <= 1; $('#nextBtn').disabled = S.cur >= S.pages.length;
  for (const p of S.pages) p.thumb?.classList.toggle('active', p.num === S.cur);
  const t = S.pages[S.cur - 1]?.thumb;
  if (t && thumbsPanel.offsetParent) {
    const tr = t.getBoundingClientRect(), pr = thumbsPanel.getBoundingClientRect();
    if (tr.top < pr.top || tr.bottom > pr.bottom) thumbsPanel.scrollTop += tr.top - pr.top - pr.height / 2 + tr.height / 2;
  }
}
function scrollToPage(n, instant = false) {
  const p = S.pages[clamp(n, 1, S.pages.length) - 1]; if (!p) return;
  const far = instant || Math.abs(p.num - S.cur) > 2; // long jumps are instant, neighbours glide
  S.cur = p.num; updatePageUI();
  scroller.scrollTo({ top: p.shell.offsetTop - 14, behavior: far ? 'auto' : 'smooth' });
}
$('#prevBtn').onclick = () => scrollToPage(S.cur - 1);
$('#nextBtn').onclick = () => scrollToPage(S.cur + 1);
pageInput.addEventListener('focus', () => pageInput.select());
pageInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); pageInput.blur(); }
  else if (e.key === 'Escape') { pageInput.value = S.cur; pageInput.blur(); }
});
pageInput.addEventListener('change', () => {
  const v = parseInt(pageInput.value, 10);
  if (Number.isFinite(v)) scrollToPage(v); else pageInput.value = S.cur;
});
pageInput.addEventListener('blur', () => { pageInput.value = S.cur; });
$('#zoomInBtn').onclick = () => zoomStep(1);
$('#zoomOutBtn').onclick = () => zoomStep(-1);
zoomLabel.onclick = () => setScale(1);
$('#fitBtn').onclick = () => setScale(fitScale('width'), null, 'width');

scroller.addEventListener('wheel', e => {
  if (!S.pdf || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  setScale(S.scale * Math.exp(-clamp(e.deltaY, -60, 60) * 0.006), { x: e.clientX, y: e.clientY });
}, { passive: false });

// pinch-to-zoom on touch screens
let pinch = null;
const tdist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
scroller.addEventListener('touchstart', e => {
  if (!S.pdf || e.touches.length !== 2 || S.dragging) return;
  const sr = scroller.getBoundingClientRect();
  const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2, cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
  pinch = { d0: tdist(e.touches), cx, cy, r: 1 };
  pagesEl.style.transformOrigin = `${scroller.scrollLeft + cx - sr.left}px ${scroller.scrollTop + cy - sr.top}px`;
}, { passive: true });
scroller.addEventListener('touchmove', e => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  pinch.r = clamp(tdist(e.touches) / pinch.d0, ZMIN / S.scale, ZMAX / S.scale);
  pagesEl.style.transform = `scale(${pinch.r})`;
}, { passive: false });
const endPinch = e => {
  if (!pinch || e.touches.length >= 2) return;
  const { r, cx, cy } = pinch; pinch = null;
  pagesEl.style.transform = ''; pagesEl.style.transformOrigin = '';
  if (Math.abs(r - 1) > 0.02) setScale(S.scale * r, { x: cx, y: cy });
};
scroller.addEventListener('touchend', endPinch);
scroller.addEventListener('touchcancel', endPinch);

// clicking empty space deselects
scroller.addEventListener('pointerdown', e => {
  if (e.target.closest('.item') || e.target.closest('.itembar')) return;
  finishEdit();
  if (S.sel) select(null);
});

let resizeTimer = 0;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!S.pdf) return;
    if (S.fit) setScale(fitScale(S.fit), null, S.fit); else positionItemBar();
  }, 120);
}).observe(scroller);

/* ---------------------------------------------------------------- export */
function dataUrlToBytes(u) { return b64ToBytes(u.slice(u.indexOf(',') + 1)); }
function canvasToBytes(c, type, q) {
  return new Promise((res, rej) => c.toBlob(b => (b ? b.arrayBuffer().then(a => res(new Uint8Array(a)), rej) : rej(new Error('Image encoding failed'))), type, q));
}
async function rasterText(it) {
  await fontsReady;
  const m = textMetrics(it);
  const K = Math.min(6, 7000 / Math.max(it.w, 1), 7000 / Math.max(it.h, 1));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(it.w * K)); c.height = Math.max(1, Math.ceil(it.h * K));
  const x = c.getContext('2d');
  x.scale(c.width / it.w, c.height / it.h);
  x.font = fontCss(it.font, it.size); x.fillStyle = it.color; x.textBaseline = 'alphabetic';
  x.fillText(it.text, m.padL, m.asc);
  return canvasToBytes(c, 'image/png');
}
async function buildExportData() {
  const imgs = {}, items = [], keyOf = new Map();
  let n = 0;
  for (const it of S.items) {
    const p = pageOf(it);
    let key;
    if (it.type === 'image') {
      key = keyOf.get(it.src);
      if (!key) { key = 'i' + n++; keyOf.set(it.src, key); imgs[key] = await normalizeToPng(it.src); }
    } else {
      if (!it.text.trim()) continue;
      key = 't' + n++; imgs[key] = await rasterText(it);
    }
    // bottom-left corner of the item (as displayed) converted into PDF user space
    const [x, y] = p.vp.convertToPdfPoint(it.x, it.y + it.h);
    items.push({ pageIndex: it.page - 1, key, x, y, w: it.w, h: it.h, rotate: p.rotate, fx: it.x, fy: p.h - it.y - it.h });
  }
  return { imgs, items };
}
async function normalizeToPng(src) {
  if (src.startsWith('data:image/png')) return dataUrlToBytes(src);
  const im = new Image(); im.src = src; await im.decode();
  const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
  c.getContext('2d').drawImage(im, 0, 0);
  return canvasToBytes(c, 'image/png');
}

/* exportCore runs inside a Web Worker (and on the main thread as a fallback). It must not use outer variables. */
async function exportCore(PDFLib, data, progress) {
  const { PDFDocument, degrees, pushGraphicsState, popGraphicsState } = PDFLib;
  progress(0.1);
  const doc = await PDFDocument.load(data.bytes, { updateMetadata: false });
  progress(0.35);
  const emb = {};
  for (const k of Object.keys(data.imgs)) emb[k] = await doc.embedPng(data.imgs[k]);
  progress(0.5);
  const pages = doc.getPages();
  const wrapped = new Set();
  for (const it of data.items) {
    const page = pages[it.pageIndex];
    if (!page) throw new Error('Page ' + (it.pageIndex + 1) + ' not found');
    if (!wrapped.has(it.pageIndex)) {
      // isolate the original page content in q/Q so its graphics state cannot shift our drawing
      wrapped.add(it.pageIndex);
      page.node.normalize();
      const ctx = doc.context;
      const a = ctx.register(page.createContentStream(pushGraphicsState()));
      const b = ctx.register(page.createContentStream(popGraphicsState()));
      page.node.wrapContentStreams(a, b);
    }
    page.drawImage(emb[it.key], { x: it.x, y: it.y, width: it.w, height: it.h, rotate: degrees(it.rotate) });
  }
  progress(0.7);
  const out = await doc.save({ useObjectStreams: true });
  progress(1);
  return out;
}
const WORKER_SRC = `const exportCore = ${exportCore.toString()};
self.onmessage = async e => {
  try {
    const out = await exportCore(self.PDFLib, e.data, v => self.postMessage({ type: 'progress', v }));
    self.postMessage({ ok: true, out }, [out.buffer]);
  } catch (err) {
    const msg = String(err && err.message || err);
    self.postMessage({ ok: false, error: msg, code: /encrypt/i.test(msg) ? 'encrypted' : 'parse' });
  }
};`;
async function runExport(payload, onProgress) {
  const code = await getPdfLibCode();
  let worker = null;
  try { worker = new Worker(URL.createObjectURL(new Blob([code, '\n', WORKER_SRC], { type: 'text/javascript' }))); } catch { worker = null; }
  if (worker) {
    try {
      return await new Promise((resolve, reject) => {
        worker.onmessage = e => {
          const d = e.data;
          if (d.type === 'progress') onProgress(d.v);
          else if (d.ok) resolve(d.out);
          else reject(Object.assign(new Error(d.error), { code: d.code }));
        };
        worker.onerror = e => { e.preventDefault?.(); reject(Object.assign(new Error('worker failed'), { code: 'worker' })); };
        worker.postMessage(payload);
      });
    } catch (err) {
      if (err.code !== 'worker') throw err;
    } finally { worker.terminate(); }
  }
  const PDFLib = await loadPdfLibMain();
  try { return await exportCore(PDFLib, payload, onProgress); }
  catch (err) { const msg = String(err?.message || err); throw Object.assign(new Error(msg), { code: /encrypt/i.test(msg) ? 'encrypted' : 'parse' }); }
}
async function exportFlattened(data, onProgress) {
  const { PDFDocument } = await loadPdfLibMain();
  const doc = await PDFDocument.create();
  const emb = {};
  for (const p of S.pages) {
    const k = Math.min(2.5, Math.sqrt(14e6 / (p.w * p.h)));
    const vp = p.pg.getViewport({ scale: k });
    const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await p.pg.render({ canvas: c, viewport: vp, annotationMode: globalThis.pdfjsLib.AnnotationMode.ENABLE, background: '#ffffff', intent: 'print' }).promise;
    const jpg = await canvasToBytes(c, 'image/jpeg', 0.92); c.width = c.height = 0;
    const page = doc.addPage([p.w, p.h]);
    page.drawImage(await doc.embedJpg(jpg), { x: 0, y: 0, width: p.w, height: p.h });
    for (const it of data.items) {
      if (it.pageIndex !== p.num - 1) continue;
      emb[it.key] = emb[it.key] || await doc.embedPng(data.imgs[it.key]);
      page.drawImage(emb[it.key], { x: it.fx, y: it.fy, width: it.w, height: it.h });
    }
    onProgress(0.1 + 0.8 * p.num / S.pages.length);
    await nextFrame();
  }
  const out = await doc.save();
  onProgress(1);
  return out;
}

function outName() {
  const base = (S.file?.name || 'document.pdf').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'document';
  return base + '-signed.pdf';
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
let exporting = false;
async function doExport() {
  if (!S.pdf || exporting) return;
  finishEdit();
  if (!S.items.length) {
    const ok = await confirmModal({ title: 'Nothing has been added yet', body: 'You have not placed a signature or any text on this document. Download an unchanged copy anyway?', ok: 'Download anyway' });
    if (!ok) return;
  }
  exporting = true;
  showBusy('Creating your signed PDF…', 'Working on this device. Nothing is uploaded.', 0.03);
  try {
    const data = await buildExportData();
    let out, flattened = false;
    try {
      out = await runExport({ bytes: S.file.bytes, ...data }, setBusyProgress);
    } catch (err) {
      console.warn('Direct export failed:', err);
      hideBusy();
      const enc = err.code === 'encrypted' || !!S.file.password;
      const ok = await confirmModal({
        title: enc ? 'This PDF is protected' : 'This PDF has an unusual structure',
        body: (enc ? 'The PDF is encrypted, so it can’t be edited directly.' : 'This PDF can’t be edited directly.') +
          ' You can still download a signed copy where each page is converted to a high-quality image. The text in that copy won’t be selectable or searchable.',
        ok: 'Create signed copy',
      });
      if (!ok) return;
      showBusy('Creating your signed PDF…', 'Converting pages on this device…', 0.05);
      out = await exportFlattened(data, setBusyProgress); flattened = true;
    }
    const blob = new Blob([out], { type: 'application/pdf' });
    const name = outName();
    S.lastBlob = blob; S.lastName = name;
    saveBlob(blob, name);
    S.dirty = false;
    const stored = await storeSignedCopy(blob, name, data.items.length, flattened);
    hideBusy();
    showDoneModal(blob, name, stored);
  } catch (err) {
    console.error(err);
    hideBusy();
    toast('Could not create the signed PDF. ' + (err?.message || ''), 'error', 6000);
  } finally { exporting = false; hideBusy(); }
}
function fmtSize(b) { return b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; }
/** Keeps a copy of every signed PDF so it can be downloaded again later from "My documents". */
async function storeSignedCopy(blob, name, itemCount, flattened) {
  if (!S.rec || !keepDocs()) return false;
  try {
    await saveNow();
    const now = Date.now();
    await DB.put('signed', { id: uid(), docId: S.rec.id, name, createdAt: now, size: blob.size, items: itemCount, flattened, blob });
    S.rec = { ...S.rec, signedCount: (S.rec.signedCount || 0) + 1, lastSignedAt: now };
    await DB.put('docs', S.rec);
    return true;
  } catch (err) { storageError(err); return false; }
}
function showDoneModal(blob, name, stored) {
  const md = openModal(`
    <div class="modal-body" style="text-align:center;padding-top:22px">
      <div class="success-icon">${ICON.check}</div>
      <h2 style="margin:0 0 6px;font-size:18px;color:var(--text)">Your signed PDF is ready</h2>
      <div class="dn" style="word-break:break-all"></div>
      <div class="muted small" style="margin-top:8px">It was created on this device and saved to your Downloads folder.${stored ? ' A copy is also kept in <b>My documents</b> so you can download it again later.' : ''}</div>
    </div>
    <div class="modal-foot" style="justify-content:center">
      <button class="btn" type="button" data-act="again">Download again</button>
      <button class="btn" type="button" data-act="new">Sign another PDF</button>
      <button class="btn primary" type="button" data-close autofocus>Keep editing</button>
    </div>`);
  md.m.querySelector('.dn').textContent = `${name} · ${fmtSize(blob.size)}`;
  md.m.querySelector('[data-act=again]').onclick = () => saveBlob(blob, name);
  md.m.querySelector('[data-act=new]').onclick = () => { md.close(); pickPdf(); };
}

/* ---------------------------------------------------------------- signature creator */
const PEN_COLORS = ['#0f172a', '#1d4ed8', '#b91c1c'];
function openSigModal() {
  const lastName = localStorage.getItem(LS_NAME) || '';
  const md = openModal(`
    <div class="modal-head"><h2>Create your signature</h2><button class="icon-btn" type="button" data-close aria-label="Close">${ICON.x}</button></div>
    <div class="tabs" role="tablist">
      <button class="tab active" type="button" role="tab" data-tab="draw">${ICON.draw}Draw</button>
      <button class="tab" type="button" role="tab" data-tab="type">${ICON.type}Type</button>
      <button class="tab" type="button" role="tab" data-tab="upload">${ICON.image}Upload</button>
    </div>
    <div class="tab-panel" data-panel="draw">
      <div class="pad-wrap"><canvas aria-label="Signature drawing area"></canvas><div class="pad-line"></div><div class="pad-x">✕</div><div class="pad-hint">Sign here with your mouse, finger or stylus</div></div>
      <div class="tool-row">
        <div class="colors" data-for="draw">${PEN_COLORS.map((c, i) => `<button type="button" class="color-dot${i ? '' : ' active'}" data-color="${c}" style="background:${c}" aria-label="Pen color"></button>`).join('')}</div>
        <label class="range">Thickness <input type="range" min="1" max="6" step="0.5" value="2.5" data-act="width"></label>
        <div class="grow" style="flex:1"></div>
        <button class="btn sm" type="button" data-act="undo-stroke">Undo</button>
        <button class="btn sm" type="button" data-act="clear">Clear</button>
      </div>
    </div>
    <div class="tab-panel" data-panel="type" hidden>
      <input class="text-input" type="text" maxlength="60" placeholder="Type your full name" aria-label="Your name" autocomplete="name">
      <div class="font-grid">${SIG_FONTS.map((f, i) => `<button type="button" class="font-opt${i ? '' : ' active'}" data-font="${f}" style="font-family:${FONTS[f].css.replace(/"/g, '&quot;')}">Your name</button>`).join('')}</div>
      <div class="tool-row"><div class="colors" data-for="type">${PEN_COLORS.map((c, i) => `<button type="button" class="color-dot${i ? '' : ' active'}" data-color="${c}" style="background:${c}" aria-label="Ink color"></button>`).join('')}</div></div>
    </div>
    <div class="tab-panel" data-panel="upload" hidden>
      <label class="upload-drop" tabindex="0">${ICON.upload}<strong>Choose an image of your signature</strong><small>PNG, JPG, WEBP or SVG · or drop it here</small><input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif,image/bmp" hidden></label>
      <div class="upload-preview" hidden><img alt="Signature preview"></div>
      <div class="tool-row upload-opts" hidden>
        <label class="check"><input type="checkbox" data-act="bg" checked> Remove background</label>
        <label class="range" data-act="th-wrap">Strength <input type="range" min="120" max="250" value="200" data-act="th"></label>
        <div class="grow" style="flex:1"></div>
        <button class="btn sm" type="button" data-act="replace">Choose another</button>
      </div>
    </div>
    <div class="modal-foot">
      <label class="check"><input type="checkbox" data-act="remember" checked> Save on this device for next time</label>
      <div class="grow" style="flex:1"></div>
      <button class="btn" type="button" data-close>Cancel</button>
      <button class="btn primary" type="button" data-act="create">${S.pdf ? 'Add to document' : 'Save signature'}</button>
    </div>`, { cls: 'sig-modal', onClose: () => { ro.disconnect(); } });
  const m = md.m;
  let tab = 'draw';
  const tabs = m.querySelectorAll('.tab');
  tabs.forEach(b => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    tabs.forEach(x => x.classList.toggle('active', x === b));
    m.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== tab; });
    if (tab === 'draw') pad.resize();
    if (tab === 'type') nameInput.focus();
  }));

  // draw
  const pad = createPad(m.querySelector('.pad-wrap canvas'), m.querySelector('.pad-hint'));
  const ro = new ResizeObserver(() => pad.resize()); ro.observe(m.querySelector('.pad-wrap'));
  m.querySelectorAll('[data-for=draw] .color-dot').forEach(b => b.addEventListener('click', () => {
    m.querySelectorAll('[data-for=draw] .color-dot').forEach(x => x.classList.toggle('active', x === b));
    pad.setColor(b.dataset.color);
  }));
  m.querySelector('[data-act=width]').addEventListener('input', e => pad.setWidth(+e.target.value));
  m.querySelector('[data-act=undo-stroke]').onclick = () => pad.undo();
  m.querySelector('[data-act=clear]').onclick = () => pad.clear();

  // type
  const nameInput = m.querySelector('.text-input');
  let typeFont = SIG_FONTS[0], typeColor = PEN_COLORS[0];
  const opts = m.querySelectorAll('.font-opt');
  const refreshType = () => opts.forEach(o => { o.textContent = nameInput.value.trim() || 'Your name'; o.style.color = typeColor; });
  nameInput.value = lastName; refreshType();
  nameInput.addEventListener('input', refreshType);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  opts.forEach(o => o.addEventListener('click', () => { typeFont = o.dataset.font; opts.forEach(x => x.classList.toggle('active', x === o)); }));
  m.querySelectorAll('[data-for=type] .color-dot').forEach(b => b.addEventListener('click', () => {
    m.querySelectorAll('[data-for=type] .color-dot').forEach(x => x.classList.toggle('active', x === b));
    typeColor = b.dataset.color; refreshType();
  }));

  // upload
  const up = { base: null, out: null };
  const drop = m.querySelector('.upload-drop'), fileIn = drop.querySelector('input');
  const preview = m.querySelector('.upload-preview'), previewImg = preview.querySelector('img'), uopts = m.querySelector('.upload-opts');
  const bgChk = m.querySelector('[data-act=bg]'), th = m.querySelector('[data-act=th]');
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } });
  fileIn.addEventListener('change', () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) loadUpload(f); });
  drop.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) loadUpload(f); });
  m.querySelector('[data-act=replace]').onclick = () => fileIn.click();
  let procRaf = 0;
  const reprocess = () => { cancelAnimationFrame(procRaf); procRaf = requestAnimationFrame(processUpload); };
  bgChk.addEventListener('change', () => { th.disabled = !bgChk.checked; reprocess(); });
  th.addEventListener('input', reprocess);
  async function loadUpload(file) {
    if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|svg|gif|bmp)$/i.test(file.name)) { toast('Please choose an image file (PNG, JPG, WEBP or SVG).', 'error'); return; }
    if (file.size > 25 * 1024 * 1024) { toast('That image is too large (max 25 MB).', 'error'); return; }
    const url = URL.createObjectURL(file);
    try {
      const im = new Image(); im.src = url; await im.decode();
      let w = im.naturalWidth || 600, h = im.naturalHeight || 200;
      const s = Math.min(1, 1600 / Math.max(w, h)); w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0, w, h);
      const d = x.getImageData(0, 0, w, h).data;
      let transparent = 0;
      for (let i = 3; i < d.length; i += 16) if (d[i] < 250) transparent++;
      up.base = c;
      bgChk.checked = transparent < (d.length / 16) * 0.02; // photos/scans: remove background by default
      th.disabled = !bgChk.checked;
      drop.hidden = true; preview.hidden = false; uopts.hidden = false;
      processUpload();
    } catch { toast('That image could not be read.', 'error'); }
    finally { URL.revokeObjectURL(url); }
  }
  function processUpload() {
    if (!up.base) return;
    const src = up.base, w = src.width, h = src.height;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0);
    const img = x.getImageData(0, 0, w, h), d = img.data;
    if (bgChk.checked) {
      const t = +th.value, soft = 40;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (lum >= t) d[i + 3] = 0;
        else if (lum > t - soft) d[i + 3] = Math.round(d[i + 3] * (t - lum) / soft);
      }
    }
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
      if (d[(y * w + xx) * 4 + 3] > 12) { if (xx < minX) minX = xx; if (xx > maxX) maxX = xx; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (maxX < 0) { up.out = null; previewImg.removeAttribute('src'); toast('Nothing is left after removing the background. Lower the strength.', 'error'); return; }
    x.putImageData(img, 0, 0);
    const pad2 = 4;
    minX = Math.max(0, minX - pad2); minY = Math.max(0, minY - pad2); maxX = Math.min(w - 1, maxX + pad2); maxY = Math.min(h - 1, maxY + pad2);
    const o = document.createElement('canvas'); o.width = maxX - minX + 1; o.height = maxY - minY + 1;
    o.getContext('2d').drawImage(c, minX, minY, o.width, o.height, 0, 0, o.width, o.height);
    up.out = o.toDataURL('image/png');
    previewImg.src = up.out;
  }

  async function create() {
    let src = null;
    if (tab === 'draw') {
      if (pad.isEmpty()) { toast('Draw your signature in the box first.', 'error'); return; }
      src = pad.toDataURL();
    } else if (tab === 'type') {
      const name = nameInput.value.trim();
      if (!name) { toast('Type your name first.', 'error'); nameInput.focus(); return; }
      await fontsReady;
      src = renderTyped(name, typeFont, typeColor);
      try { localStorage.setItem(LS_NAME, name); } catch {}
    } else {
      if (!up.out) { toast('Choose an image of your signature first.', 'error'); return; }
      src = up.out;
    }
    const remember = m.querySelector('[data-act=remember]').checked;
    addSignature(src, remember);
    md.close();
    if (S.pdf) await placePayload({ type: 'sig', src });
    else toast('Signature saved. Open a PDF to use it.', 'success');
  }
  m.querySelector('[data-act=create]').onclick = create;
  requestAnimationFrame(() => pad.resize());
}

function renderTyped(text, font, color) {
  const B = 120, c = document.createElement('canvas'), x = c.getContext('2d');
  x.font = fontCss(font, B);
  const m = x.measureText(text);
  const L = Math.max(0, m.actualBoundingBoxLeft || 0), Rr = Math.max(m.width, m.actualBoundingBoxRight || 0);
  const A = m.actualBoundingBoxAscent || B * 0.8, D = m.actualBoundingBoxDescent || B * 0.25, pad = 12;
  c.width = Math.ceil(L + Rr + pad * 2); c.height = Math.ceil(A + D + pad * 2);
  x.font = fontCss(font, B); x.fillStyle = color; x.textBaseline = 'alphabetic';
  x.fillText(text, pad + L, pad + A);
  return c.toDataURL('image/png');
}

function createPad(canvas, hint) {
  const ctx = canvas.getContext('2d');
  const st = { strokes: [], cur: null, color: PEN_COLORS[0], base: 2.5, cssW: 0, cssH: 0, dpr: 1 };
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  function seg(c, a, ctrl, b, w, color) {
    c.strokeStyle = color; c.lineWidth = w; c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(a.x, a.y);
    if (ctrl) c.quadraticCurveTo(ctrl.x, ctrl.y, b.x, b.y); else c.lineTo(b.x, b.y);
    c.stroke();
  }
  function dot(c, p, color) { c.fillStyle = color; c.beginPath(); c.arc(p.x, p.y, p.w / 2, 0, Math.PI * 2); c.fill(); }
  function drawStroke(c, s) {
    const P = s.pts, n = P.length;
    if (n === 1) { dot(c, P[0], s.color); return; }
    seg(c, P[0], null, mid(P[0], P[1]), P[0].w, s.color);
    for (let i = 1; i < n - 1; i++) seg(c, mid(P[i - 1], P[i]), P[i], mid(P[i], P[i + 1]), P[i].w, s.color);
    if (s.done) seg(c, mid(P[n - 2], P[n - 1]), null, P[n - 1], P[n - 1].w, s.color);
  }
  function redraw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    for (const s of st.strokes) drawStroke(ctx, s);
    hint.hidden = st.strokes.length > 0;
  }
  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    st.dpr = window.devicePixelRatio || 1; st.cssW = r.width; st.cssH = r.height;
    canvas.width = Math.round(r.width * st.dpr); canvas.height = Math.round(r.height * st.dpr);
    redraw();
  }
  function pos(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function addPoint(e) {
    const s = st.cur, P = s.pts, last = P[P.length - 1], { x, y } = pos(e), t = e.timeStamp || performance.now();
    let w;
    if (e.pointerType === 'pen' && e.pressure > 0) w = st.base * (0.35 + e.pressure * 1.3);
    else if (!last) w = st.base;
    else {
      const d = Math.hypot(x - last.x, y - last.y);
      if (d < 0.75) return false;
      const v = d / Math.max(1, t - last.t);
      const target = st.base * clamp(1.5 - v * 0.5, 0.5, 1.5);
      w = last.w * 0.7 + target * 0.3;
    }
    P.push({ x, y, t, w });
    return true;
  }
  // move/up are tracked on window so a stroke continues smoothly even if the pen leaves the box
  const move = e => {
    const s = st.cur; if (!s || e.pointerId !== s.pid) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    for (const ev of (evs.length ? evs : [e])) {
      if (!addPoint(ev)) continue;
      const P = s.pts, n = P.length;
      if (n === 2) redraw(); // replace the start dot with the stroke head
      else if (n >= 3) seg(ctx, mid(P[n - 3], P[n - 2]), P[n - 2], mid(P[n - 2], P[n - 1]), P[n - 2].w, s.color);
    }
  };
  const end = e => {
    const s = st.cur; if (!s || e.pointerId !== s.pid) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    s.done = true; st.cur = null;
    redraw();
  };
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (st.cur) return; // ignore a second finger while drawing
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    st.cur = { color: st.color, pts: [], done: false, pid: e.pointerId };
    st.strokes.push(st.cur);
    addPoint(e);
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    dot(ctx, st.cur.pts[0], st.color);
    hint.hidden = true;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });
  return {
    resize,
    setColor(c) { st.color = c; for (const s of st.strokes) s.color = c; redraw(); },
    setWidth(w) { st.base = w; },
    undo() { st.strokes.pop(); redraw(); },
    clear() { st.strokes = []; redraw(); },
    isEmpty() { return !st.strokes.some(s => s.pts.length); },
    toDataURL() {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of st.strokes) for (const p of s.pts) {
        minX = Math.min(minX, p.x - p.w); minY = Math.min(minY, p.y - p.w); maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.w);
      }
      const pad = 4; minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      const w = maxX - minX, h = maxY - minY, K = Math.min(4, 2400 / w, 1200 / h);
      const c = document.createElement('canvas'); c.width = Math.ceil(w * K); c.height = Math.ceil(h * K);
      const x = c.getContext('2d'); x.setTransform(K, 0, 0, K, -minX * K, -minY * K);
      for (const s of st.strokes) drawStroke(x, { ...s, done: true });
      return c.toDataURL('image/png');
    },
  };
}

/* ---------------------------------------------------------------- My documents (local library) */
function relTime(t) {
  const s = (Date.now() - (t || 0)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  if (s < 86400 * 7) return Math.round(s / 86400) + ' d ago';
  return new Date(t).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}
const fmtStamp = t => new Date(t).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
async function loadLibrary() {
  const [docs, signed] = await Promise.all([DB.all('docs'), DB.all('signed')]);
  const byDoc = new Map();
  for (const s of signed) { if (!byDoc.has(s.docId)) byDoc.set(s.docId, []); byDoc.get(s.docId).push(s); }
  for (const list of byDoc.values()) list.sort((a, b) => b.createdAt - a.createdAt);
  // the open document's latest autosave may be newer than what is on disk
  return docs.map(d => (S.rec?.id === d.id ? { ...d, ...S.rec } : d))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(doc => ({ doc, signed: byDoc.get(doc.id) || [] }));
}
function docRow({ doc, signed }, { compact = false, onChange } = {}) {
  const row = document.createElement('div'); row.className = 'doc-row';
  const thumb = document.createElement('div'); thumb.className = 'doc-thumb';
  if (typeof doc.thumb === 'string' && doc.thumb.startsWith('data:image/')) { const im = new Image(); im.src = doc.thumb; im.alt = ''; thumb.append(im); }
  const main = document.createElement('div'); main.className = 'doc-main';
  const nm = document.createElement('div'); nm.className = 'doc-name'; nm.textContent = doc.name; nm.title = doc.name;
  const meta = document.createElement('div'); meta.className = 'doc-meta';
  const n = doc.items?.length || 0, pages = doc.pages || 0;
  const status = document.createElement('span'); status.className = 'doc-status ' + (signed.length ? 'signed' : 'draft');
  status.textContent = signed.length ? 'Signed' : 'Draft';
  meta.append(status, document.createTextNode(`${pages} page${pages === 1 ? '' : 's'} · ${n} item${n === 1 ? '' : 's'} · edited ${relTime(doc.updatedAt)}`));
  main.append(nm, meta);
  if (signed.length) {
    const list = document.createElement('div'); list.className = 'doc-signed';
    for (const s of (compact ? signed.slice(0, 1) : signed)) {
      const line = document.createElement('div'); line.className = 'signed-line';
      const dl = document.createElement('button'); dl.type = 'button'; dl.className = 'link-btn'; dl.innerHTML = ICON.download;
      const label = document.createElement('span');
      label.textContent = compact ? `Download signed copy (${fmtStamp(s.createdAt)})` : `${s.name} · ${fmtStamp(s.createdAt)} · ${fmtSize(s.size)}${s.flattened ? ' · image copy' : ''}`;
      dl.append(label); dl.title = 'Download ' + s.name;
      dl.onclick = () => saveBlob(s.blob, s.name);
      line.append(dl);
      if (!compact) {
        const x = document.createElement('button'); x.type = 'button'; x.className = 'icon-btn sm'; x.innerHTML = ICON.trash;
        x.title = 'Delete this signed copy'; x.setAttribute('aria-label', 'Delete this signed copy');
        x.onclick = async () => {
          const ok = await confirmModal({ title: 'Delete this signed copy?', body: `“${s.name}” from ${fmtStamp(s.createdAt)} will be removed from this device. Files you already downloaded are not affected.`, ok: 'Delete', danger: true });
          if (!ok) return;
          await DB.del('signed', s.id).catch(storageError); onChange?.();
        };
        line.append(x);
      }
      list.append(line);
    }
    if (compact && signed.length > 1) { const more = document.createElement('span'); more.className = 'muted small'; more.textContent = `+${signed.length - 1} earlier signed cop${signed.length > 2 ? 'ies' : 'y'}`; list.append(more); }
    main.append(list);
  }
  const actions = document.createElement('div'); actions.className = 'doc-actions';
  const isOpen = S.rec?.id === doc.id;
  const open = document.createElement('button'); open.type = 'button'; open.className = 'btn sm ' + (isOpen ? '' : 'primary');
  open.textContent = isOpen ? 'Open now' : signed.length ? 'Open' : 'Continue';
  open.disabled = isOpen;
  open.onclick = async () => { while (modalStack.length) topModal().close(); await openStoredDoc(doc.id); };
  const del = document.createElement('button'); del.type = 'button'; del.className = 'icon-btn'; del.innerHTML = ICON.trash;
  del.title = 'Delete document'; del.setAttribute('aria-label', 'Delete document ' + doc.name);
  del.onclick = async () => {
    const ok = await confirmModal({ title: 'Delete this document?', body: `“${doc.name}”, its saved fields${signed.length ? ` and ${signed.length} signed cop${signed.length > 1 ? 'ies' : 'y'}` : ''} will be removed from this device. Files you already downloaded are not affected.`, ok: 'Delete', danger: true });
    if (!ok) return;
    try { await DB.deleteDoc(doc.id); } catch (err) { storageError(err); return; }
    if (S.rec?.id === doc.id) { clearTimeout(saveTimer); S.rec = null; DB.put('kv', null, 'session').catch(() => {}); }
    toast('Document deleted.'); onChange?.();
  };
  actions.append(open, del);
  row.append(thumb, main, actions);
  return row;
}
async function renderRecent() {
  const box = $('#recent');
  if (!keepDocs()) { box.hidden = true; return; }
  let lib = [];
  try { lib = await loadLibrary(); } catch { box.hidden = true; return; }
  box.hidden = !lib.length;
  box.querySelector('.recent-list').replaceChildren(...lib.slice(0, 4).map(e => docRow(e, { compact: true, onChange: renderRecent })));
  $('#recentAll').textContent = lib.length > 4 ? `View all ${lib.length}` : 'Manage';
}
function openDocsModal() {
  const md = openModal(`
    <div class="modal-head"><h2>My documents</h2><button class="icon-btn" type="button" data-close aria-label="Close">${ICON.x}</button></div>
    <div class="modal-body">
      <p class="docs-note">Saved only in this browser on this device. Nothing is uploaded. Anyone using this browser profile can open them, so on a shared computer use <b>Clear all data</b> when you’re done.</p>
      <div class="docs-list"></div>
    </div>
    <div class="modal-foot docs-foot">
      <label class="check"><input type="checkbox" data-act="keep"> Keep documents &amp; signed copies on this device</label>
      <span class="usage muted small"></span>
      <div class="grow" style="flex:1"></div>
      <button class="btn" type="button" data-act="clear">Clear all data</button>
    </div>`, { cls: 'docs-modal' });
  const m = md.m, listEl = m.querySelector('.docs-list'), keep = m.querySelector('[data-act=keep]');
  const refresh = async () => {
    let lib = [];
    try { lib = await loadLibrary(); } catch (err) { storageError(err); }
    if (!lib.length) {
      const e = document.createElement('div'); e.className = 'sig-empty';
      e.textContent = keepDocs() ? 'No documents yet. PDFs you open are saved here automatically, together with every signed copy you download.' : 'Saving documents on this device is turned off.';
      listEl.replaceChildren(e);
    } else listEl.replaceChildren(...lib.map(e => docRow(e, { onChange: refresh })));
    try { const est = await navigator.storage?.estimate?.(); if (est?.usage != null) m.querySelector('.usage').textContent = fmtSize(est.usage) + ' used'; } catch {}
    renderRecent();
  };
  keep.checked = keepDocs();
  keep.onchange = async () => {
    try { localStorage.setItem(LS_KEEP, keep.checked ? '1' : '0'); } catch {}
    if (!keep.checked) {
      clearTimeout(saveTimer); S.rec = null; DB.put('kv', null, 'session').catch(() => {});
      toast('New work won’t be saved on this device. Documents already saved stay until you delete them.', 'info', 5000);
    } else if (S.pdf && !S.rec) {
      await linkRecord(null, S.file.name, S.file.bytes, null); await saveNow();
      toast('Saving is on. This document is now saved on this device.', 'success');
    }
    refresh();
  };
  m.querySelector('[data-act=clear]').onclick = async () => {
    const ok = await confirmModal({ title: 'Clear all data?', body: 'This removes every saved document, signed copy and saved signature from this browser. Files you already downloaded are not affected. This cannot be undone.', ok: 'Clear everything', danger: true });
    if (!ok) return;
    try { await DB.clearAll(); } catch (err) { storageError(err); return; }
    clearTimeout(saveTimer); S.rec = null;
    S.sigs = S.sigs.filter(s => !s.saved);
    try { localStorage.removeItem(LS_NAME); localStorage.removeItem(LS_SIGS); } catch {}
    renderSigLists(); refresh();
    toast('All data was removed from this device.', 'success');
  };
  refresh();
}

/* ---------------------------------------------------------------- mobile sheet */
const sheet = $('#sheet'), sheetBackdrop = $('#sheetBackdrop');
function openSheet() {
  if (!S.sigs.length) { openSigModal(); return; }
  sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false'); sheetBackdrop.hidden = false;
}
function closeSheet() { sheet.classList.remove('open'); sheet.setAttribute('aria-hidden', 'true'); sheetBackdrop.hidden = true; }
sheetBackdrop.addEventListener('click', closeSheet);
$('#sheetNewSigBtn').onclick = () => { closeSheet(); openSigModal(); };

/* ---------------------------------------------------------------- wiring */
$('#newSigBtn').onclick = openSigModal;
bindSource($('#addTextBtn'), () => ({ type: 'text' }));
bindSource($('#addDateBtn'), () => ({ type: 'date' }));
$('#mSigBtn').onclick = openSheet;
$('#mTextBtn').onclick = () => placePayload({ type: 'text' });
$('#mDateBtn').onclick = () => placePayload({ type: 'date' });
undoBtn.onclick = undo; redoBtn.onclick = redo;
$('#openBtn').onclick = pickPdf;
$('#docsBtn').onclick = openDocsModal;
$('#recentAll').onclick = openDocsModal;
$('#brandBtn').onclick = () => { if (S.pdf) goHome(); };
$('#downloadBtn').onclick = doExport;
pdfInput.addEventListener('change', () => { const f = pdfInput.files[0]; pdfInput.value = ''; if (f) openPdfFile(f); });

const dropzone = $('#dropzone');
dropzone.addEventListener('click', pickPdf);
dropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickPdf(); } });

// drag & drop a PDF anywhere on the window
const dropOverlay = $('#dropOverlay');
let dragDepth = 0;
const isFileDrag = e => Array.from(e.dataTransfer?.types || []).includes('Files');
window.addEventListener('dragenter', e => {
  if (!isFileDrag(e) || modalStack.length) return;
  dragDepth++; dropOverlay.hidden = false; dropzone.classList.add('over');
});
window.addEventListener('dragleave', e => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) { dropOverlay.hidden = true; dropzone.classList.remove('over'); }
});
window.addEventListener('dragover', e => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0; dropOverlay.hidden = true; dropzone.classList.remove('over');
  if (modalStack.length) return;
  const files = Array.from(e.dataTransfer.files || []);
  const pdf = files.find(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf') || files[0];
  if (pdf) openPdfFile(pdf);
});

document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (modalStack.length) {
    if (e.key === 'Escape' && topModal().dismissible) { e.preventDefault(); topModal().close(); }
    return;
  }
  if (sheet.classList.contains('open') && e.key === 'Escape') { closeSheet(); return; }
  if (mod && k === 'o') { e.preventDefault(); pickPdf(); return; }
  if (!S.pdf) return;
  if (mod && k === 's') { e.preventDefault(); doExport(); return; }
  const a = document.activeElement;
  if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomStep(1); return; }
  if (mod && e.key === '-') { e.preventDefault(); zoomStep(-1); return; }
  if (mod && e.key === '0') { e.preventDefault(); setScale(1); return; }
  const it = getItem(S.sel);
  if (!it) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteItem(it.id); }
  else if (e.key === 'Escape') { select(null); }
  else if (e.key === 'Enter' && it.type === 'text') { e.preventDefault(); startEdit(it); }
  else if (mod && k === 'd') { e.preventDefault(); duplicateItem(it); }
  else if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1, p = pageOf(it);
    if (!nudge.t || performance.now() - nudge.t > 800) pushHist(snapshot());
    nudge.t = performance.now();
    if (e.key === 'ArrowLeft') it.x -= step; if (e.key === 'ArrowRight') it.x += step;
    if (e.key === 'ArrowUp') it.y -= step; if (e.key === 'ArrowDown') it.y += step;
    it.x = clamp(it.x, 0, Math.max(0, p.w - it.w)); it.y = clamp(it.y, 0, Math.max(0, p.h - it.h));
    layoutItem(it); positionItemBar(); markDirty();
  }
});
const nudge = { t: 0 };

window.addEventListener('beforeunload', e => {
  saveNow();
  // work that is autosaved is never lost, so only warn when it can't be saved
  if (S.pdf && S.dirty && S.items.length && (!S.rec || S.saveFailed)) { e.preventDefault(); e.returnValue = ''; }
});
window.addEventListener('pagehide', () => saveNow());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });

/* ---------------------------------------------------------------- boot */
if (/(^|[#&])debug\b/.test(location.hash.slice(1))) window.__signer = { S, DB, buildExportData, runExport, exportFlattened, setScale, select, textMetrics, saveNow, goHome, openStoredDoc };
renderSigLists();
(async () => { // restore signatures, then the document that was open before the refresh
  await loadSigs();
  if (!keepDocs()) return;
  let session = null;
  try { session = await DB.get('kv', 'session'); } catch {}
  if (session?.docId && !S.pdf) {
    const ok = await openStoredDoc(session.docId, { page: session.page, restoring: true });
    if (ok) toast(`Restored “${S.file.name}”. Your work is saved on this device automatically.`, 'success', 4500);
    else DB.put('kv', null, 'session').catch(() => {});
  }
  if (!S.pdf) renderRecent();
})();
// warm up the PDF engine in the background so opening a file is instant
setTimeout(() => { loadPdfJs().catch(err => { console.error(err); toast(err.message || 'The PDF engine could not start.', 'error', 8000); }); }, 50);
})();
