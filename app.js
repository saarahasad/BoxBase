/* BOXBASE — cloud version (Firebase Auth + Firestore with offline cache) */
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail, signOut, connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  collection, doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, onSnapshot, query, where,
  writeBatch, arrayUnion, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

/* ================= helpers ================= */
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
function toast(msg) {
  document.querySelectorAll('.toast').forEach(x => x.remove());
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.append(t); setTimeout(() => t.remove(), 2400);
}
const baseUrl = () => localStorage.getItem('bb-base') || (location.origin + location.pathname);
const boxUrl = id => baseUrl() + '#/box/' + encodeURIComponent(id);
function qrSvg(text) {
  if (typeof qrcode === 'undefined') return '<div class="tag">QR lib offline</div>';
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}
function parseItem(raw) {
  const t = raw.trim(); if (!t) return null;
  const m = t.match(/^(\d+)\s*[x×]\s*(.+)$/i) || t.match(/^(.+?)\s*[x×]\s*(\d+)$/i);
  if (m) { const [n, q] = /^\d+$/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]]; return { n: n.trim(), q: +q }; }
  return { n: t, q: 1 };
}
async function bitmap(src) {
  const blob = src instanceof Blob ? src : await (await fetch(src)).blob();
  return createImageBitmap(blob);
}
function drawJpeg(img, max, quality) {
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}
/* full photo (~150–250KB) + tiny thumb (~10KB) */
async function photo(src) { const img = await bitmap(src); return { p: drawJpeg(img, 1100, 0.72), t: drawJpeg(img, 220, 0.6) }; }
function lightbox(src, loadFull) {
  const lb = document.createElement('div'); lb.className = 'lightbox';
  lb.innerHTML = `<img src="${src}">`; lb.onclick = () => lb.remove(); document.body.append(lb);
  loadFull?.().then(p => { if (p) lb.querySelector('img').src = p; }).catch(() => {});
}

/* ================= firebase ================= */
const configured = !!(firebaseConfig?.apiKey && !/PASTE/i.test(firebaseConfig.apiKey));
let auth, db;
if (configured) {
  const fb = initializeApp(firebaseConfig);
  auth = getAuth(fb);
  db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  if (firebaseConfig.useEmulator) {           // local testing only
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
}

/* ================= state ================= */
let user = null, homeId = null, home = null, homes = [];
const boxesM = new Map(), itemsM = new Map(), boxPhotos = new Map();
const ready = { boxes: false, items: false };
let booted = false, unsubs = [], photoSub = { box: null, unsub: null };
const sync = { pending: {}, cache: {} };
let pendingFocus = null, legacy = [], searchTerm = '', seq = 0;

const col = n => collection(db, 'homes', homeId, n);
const ref = (n, id) => doc(db, 'homes', homeId, n, id);
const newRef = n => doc(col(n));
const fail = e => { console.error(e); toast('⚠ ' + (e?.code || e?.message || 'Something went wrong')); };
const w = p => { p.catch(fail); };   // writes apply locally at once; server ack happens in background

const sorted = () => [...boxesM.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
const byId = id => boxesM.get(id);
const itemsOf = id => [...itemsM.values()].filter(i => i.box === id).sort((a, b) => (a.created || 0) - (b.created || 0));
const nextId = () => pad([...boxesM.keys()].reduce((m, k) => Math.max(m, parseInt(k) || 0), 0) + 1);

/* ================= data ops ================= */
function createBox(id = nextId(), extra = {}) {
  const b = { name: '', location: '', category: '', notes: '', cover: null, created: Date.now(), updated: Date.now(), ...extra };
  boxesM.set(id, { ...b, id });
  w(setDoc(ref('boxes', id), b));
  return id;
}
function setBox(id, patch) {
  const b = byId(id); if (b) Object.assign(b, patch);
  w(updateDoc(ref('boxes', id), { ...patch, updated: Date.now() }));
}
function addItem(box, { n = '', q = 1, t = null, p = null }) {
  let img = null;
  if (p) { const r = newRef('images'); img = r.id; w(setDoc(r, { p, t, box, kind: 'item', created: Date.now() })); }
  const r = newRef('items');
  const it = { box, n, q, t, img, created: Date.now() + (seq++) };
  itemsM.set(r.id, { ...it, id: r.id });
  w(setDoc(r, it));
  w(updateDoc(ref('boxes', box), { updated: Date.now() }));
  return r.id;
}
function renameItem(it, value) {
  const parsed = parseItem(value);
  const patch = { n: parsed ? parsed.n : '' };
  if (parsed?.q > 1) patch.q = parsed.q;
  Object.assign(it, patch);
  w(updateDoc(ref('items', it.id), patch));
}
function setItemPhoto(it, { p, t }) {
  const r = newRef('images');
  w(setDoc(r, { p, t, box: it.box, kind: 'item', created: Date.now() }));
  if (it.img) w(deleteDoc(ref('images', it.img)));
  Object.assign(it, { t, img: r.id });
  w(updateDoc(ref('items', it.id), { t, img: r.id }));
}
function delItem(it) {
  itemsM.delete(it.id);
  w(deleteDoc(ref('items', it.id)));
  if (it.img) w(deleteDoc(ref('images', it.img)));
}
const fullImage = id => getDoc(ref('images', id)).then(d => d.data()?.p);
function addBoxPhoto(box, { p, t }) {
  const r = newRef('images'), ph = { p, t, box, kind: 'box', created: Date.now() + (seq++) };
  boxPhotos.set(box, [...(boxPhotos.get(box) || []), { ...ph, id: r.id }]);
  w(setDoc(r, ph));
  if (!byId(box)?.cover) setBox(box, { cover: t });
}
function delBoxPhoto(box, ph) {
  w(deleteDoc(ref('images', ph.id)));
  const rest = (boxPhotos.get(box) || []).filter(x => x.id !== ph.id);
  if (byId(box)?.cover === ph.t) setBox(box, { cover: rest[0]?.t || null });
}
async function delBox(id) {
  const its = itemsOf(id);
  const batch = writeBatch(db);
  its.forEach(i => batch.delete(ref('items', i.id)));
  (await getDocs(query(col('images'), where('box', '==', id)))).forEach(d => batch.delete(d.ref));
  batch.delete(ref('boxes', id));
  its.forEach(i => itemsM.delete(i.id)); boxesM.delete(id);
  w(batch.commit());
}

/* move boxes saved by the old on-device version (or a v1 backup) into the cloud */
async function migrate(list) {
  let n = 0;
  for (const b of list) {
    const id = boxesM.has(b.id) ? nextId() : b.id;
    createBox(id, { name: b.name || '', location: b.location || '', category: b.category || '', notes: b.notes || '' });
    const safe = async p => { try { return await photo(p); } catch (e) { console.warn('skipped a photo', e); return null; } };
    for (const p of b.photos || []) { const ph = await safe(p); if (ph) addBoxPhoto(id, ph); }
    for (const it of b.items || []) addItem(id, { n: it.n || '', q: it.q || 1, ...(it.p ? await safe(it.p) : null) });
    toast(`Moved ${++n} of ${list.length} boxes…`);
  }
  return n;
}
function readLegacy() {
  return new Promise(res => {
    let r;
    try { r = indexedDB.open('boxbase'); } catch { return res([]); }
    r.onupgradeneeded = () => { r.transaction.abort(); };
    r.onerror = () => res([]);
    r.onsuccess = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('boxes')) { d.close(); return res([]); }
      const g = d.transaction('boxes').objectStore('boxes').getAll();
      g.onsuccess = () => { res(g.result || []); d.close(); };
      g.onerror = () => res([]);
    };
  });
}

/* ================= sync indicator ================= */
function meta(key, s) { sync.pending[key] = s.metadata.hasPendingWrites; sync.cache[key] = s.metadata.fromCache; drawSync(); }
function drawSync() {
  const el = $('#sync'); if (!el) return;
  const pend = Object.values(sync.pending).some(Boolean);
  const cache = Object.values(sync.cache).some(Boolean);
  const [cls, txt] = !navigator.onLine ? ['off', pend ? 'Offline · will sync' : 'Offline']
    : pend ? ['wait', 'Saving…'] : cache ? ['wait', 'Connecting…'] : ['ok', 'Saved'];
  el.className = 'sync ' + cls; el.textContent = txt;
}
addEventListener('online', drawSync); addEventListener('offline', drawSync);

/* ================= session ================= */
function teardown() {
  unsubs.forEach(u => u()); unsubs = [];
  photoSub.unsub?.(); photoSub = { box: null, unsub: null };
  boxesM.clear(); itemsM.clear(); boxPhotos.clear();
  ready.boxes = ready.items = false; booted = false; homeId = null; home = null;
}
async function pickHome() {
  const email = user.email.toLowerCase(), key = 'bb-home-' + user.uid, saved = localStorage.getItem(key);
  let s;
  try { s = await getDocs(query(collection(db, 'homes'), where('members', 'array-contains', email))); }
  catch (e) { if (saved) { homeId = saved; return; } throw e; }
  homes = s.docs.map(d => ({ id: d.id, ...d.data() }));
  if (!homes.length) {
    if (s.metadata.fromCache) { if (saved) { homeId = saved; return; } throw new Error('You’re offline. Connect once to set up your account.'); }
    homeId = user.uid;
    home = { name: 'Home', owner: user.uid, ownerEmail: email, members: [email], created: Date.now() };
    await setDoc(doc(db, 'homes', homeId), home);
    homes = [{ id: homeId, ...home }];
  } else {
    const pick = homes.find(h => h.id === saved) || homes.find(h => h.owner !== user.uid) || homes[0];
    homeId = pick.id; home = pick;
  }
  localStorage.setItem(key, homeId);
}
function listen() {
  const opts = { includeMetadataChanges: true };
  unsubs.push(onSnapshot(doc(db, 'homes', homeId), d => { if (d.exists()) home = d.data(); }, fail));
  unsubs.push(onSnapshot(col('boxes'), opts, s => {
    meta('b', s);
    if (ready.boxes && !s.docChanges().length) return;
    boxesM.clear(); s.forEach(d => boxesM.set(d.id, { ...d.data(), id: d.id }));
    ready.boxes = true; refresh();
  }, fail));
  unsubs.push(onSnapshot(col('items'), opts, s => {
    meta('i', s);
    if (ready.items && !s.docChanges().length) return;
    itemsM.clear(); s.forEach(d => itemsM.set(d.id, { ...d.data(), id: d.id }));
    ready.items = true; refresh();
  }, fail));
}
function watchBoxPhotos(id) {
  if (photoSub.box === id) return;
  photoSub.unsub?.();
  photoSub = {
    box: id,
    unsub: onSnapshot(query(col('images'), where('box', '==', id), where('kind', '==', 'box')), s => {
      boxPhotos.set(id, s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.created || 0) - (b.created || 0)));
      refresh();
    }, fail),
  };
}

/* re-render on changes; if someone is typing, keep their field, text and cursor */
const typing = () => {
  const a = document.activeElement;
  return a && app.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['file', 'checkbox', 'radio'].includes(a.type)));
};
function refresh() {
  if (!ready.boxes || !ready.items) return;
  if (!booted) { booted = true; return render(); }
  if (!['home', 'search', 'box'].includes(route().name)) return;
  let keep = null;
  if (typing()) {
    const a = document.activeElement;
    const key = a.id ? '#' + a.id : a.dataset.nm ? `[data-nm="${a.dataset.nm}"]` : a.dataset.f ? `[data-f="${a.dataset.f}"]` : null;
    if (key) keep = { key, v: a.value, s: a.selectionStart, e: a.selectionEnd };
  }
  render(true);
  if (keep) {
    const el = app.querySelector(keep.key);
    if (el) { el.value = keep.v; el.focus({ preventScroll: true }); try { el.setSelectionRange(keep.s, keep.e); } catch {} }
  }
}

/* ================= views ================= */
function viewSetup() {
  app.innerHTML = `<div class="login"><div class="mark">BOX<span>BASE</span></div>
    <div class="card panel"><h2>ALMOST THERE</h2>
    <p style="line-height:1.5">Paste your Firebase web config into <code>firebase-config.js</code>, push, and reload. Steps are in <code>SETUP.md</code>.</p></div></div>`;
}

const authMsg = e => ({
  'auth/invalid-credential': 'Wrong email or password', 'auth/wrong-password': 'Wrong email or password',
  'auth/user-not-found': 'No account with that email', 'auth/email-already-in-use': 'That email already has an account — sign in',
  'auth/weak-password': 'Password needs 6+ characters', 'auth/popup-blocked': 'Popup blocked — use email sign-in',
  'auth/popup-closed-by-user': 'Sign-in cancelled', 'auth/network-request-failed': 'No internet connection',
  'auth/unauthorized-domain': 'Add this site to Firebase → Auth → Authorized domains',
}[e.code] || e.message);

function viewLogin() {
  app.innerHTML = `<div class="login">
    <div class="mark">BOX<span>BASE</span></div>
    <p class="tag" style="font-size:12px">Scan a box · see what’s inside · saved to the cloud</p>
    <button class="btn hot big" id="g">Continue with Google</button>
    <div class="or tag">or use email</div>
    <form id="ef" class="stack">
      <input class="field" type="email" id="em" placeholder="Email" required autocomplete="email">
      <input class="field" type="password" id="pw" placeholder="Password (6+ characters)" required minlength="6" autocomplete="current-password">
      <div class="row" style="margin-top:6px"><button class="btn ink" style="flex:1">Sign in</button><button type="button" class="btn" id="up" style="flex:1">Create account</button></div>
      <button type="button" class="btn ghost" id="fg" style="align-self:flex-start;padding-left:0">Forgot password?</button>
    </form></div>`;
  $('#g').onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch(e => toast(authMsg(e)));
  const creds = () => [$('#em').value.trim(), $('#pw').value];
  $('#ef').onsubmit = e => { e.preventDefault(); signInWithEmailAndPassword(auth, ...creds()).catch(e => toast(authMsg(e))); };
  $('#up').onclick = async () => {
    if (!$('#ef').reportValidity()) return;
    try { const c = await createUserWithEmailAndPassword(auth, ...creds()); await sendEmailVerification(c.user); }
    catch (e) { toast(authMsg(e)); }
  };
  $('#fg').onclick = () => {
    const em = $('#em').value.trim(); if (!em) return toast('Type your email first');
    sendPasswordResetEmail(auth, em).then(() => toast('Reset link sent')).catch(e => toast(authMsg(e)));
  };
}
function viewVerify() {
  app.innerHTML = `<div class="login"><div class="mark">BOX<span>BASE</span></div>
    <div class="card panel"><h2>CHECK YOUR INBOX</h2>
    <p style="line-height:1.5;margin-bottom:14px">We sent a link to <b>${esc(user.email)}</b>. Tap it, then come back here.</p>
    <div class="stack"><button class="btn hot big" id="done">I’ve verified</button>
    <div class="row"><button class="btn" id="again" style="flex:1">Resend</button><button class="btn ghost" id="out" style="flex:1">Sign out</button></div></div></div></div>`;
  $('#done').onclick = async () => {
    await user.reload();
    if (!auth.currentUser.emailVerified) return toast('Not verified yet');
    await auth.currentUser.getIdToken(true); start(auth.currentUser);
  };
  $('#again').onclick = () => sendEmailVerification(user).then(() => toast('Sent again')).catch(e => toast(authMsg(e)));
  $('#out').onclick = () => signOut(auth);
}

function viewHome(focus = false) {
  const list = sorted();
  const totalItems = itemsM.size;
  const showMig = legacy.length && !localStorage.getItem('bb-migrated-' + homeId);
  app.innerHTML = `
    ${showMig ? `<div class="banner card"><div><b>${legacy.length} box${legacy.length > 1 ? 'es are' : ' is'} only on this phone.</b><div class="tag" style="color:var(--ink)">Move them to the cloud so they’re safe.</div></div><button class="btn ink" id="mig">Move</button></div>` : ''}
    <div class="search"><b>⌕</b><input id="q" placeholder="Where’s the… passport? charger?" value="${esc(searchTerm)}" autocomplete="off" enterkeyhint="search"></div>
    <div class="stats">
      <div><strong>${list.length}</strong>boxes</div>
      <div><strong>${totalItems}</strong>items</div>
      <div><strong>${new Set(list.map(b => b.location).filter(Boolean)).size}</strong>spots</div>
    </div>
    <div id="results"></div>`;
  $('#mig')?.addEventListener('click', doMigrate);
  const input = $('#q');
  const draw = () => {
    searchTerm = input.value;
    const term = searchTerm.trim().toLowerCase();
    const r = $('#results');
    if (!term) {
      r.innerHTML = list.length ? `<div class="grid">${list.map(boxCard).join('')}</div>`
        : `<div class="empty">No boxes yet.<br>Tap the orange <b>+</b> — or print a sheet of blank labels first from <a href="#/labels">Labels</a>.</div>`;
      return;
    }
    const hits = [];
    for (const b of list) {
      for (const it of itemsOf(b.id)) if (it.n.toLowerCase().includes(term)) hits.push({ b, text: it.n, q: it.q, t: it.t });
      if ([b.name, b.location, b.category, b.notes].some(f => (f || '').toLowerCase().includes(term))) hits.push({ b, text: b.name || 'Box ' + b.id, boxMatch: true, t: b.cover });
    }
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const hl = s => esc(s).replace(rx, m => `<mark>${m}</mark>`);
    r.innerHTML = hits.length ? `<div class="hits">${hits.map(h => `
      <a class="hit card" href="#/box/${encodeURIComponent(h.b.id)}">
        <div class="n">${esc(h.b.id)}</div>
        <div style="min-width:0"><div style="font-weight:800;font-size:17px">${hl(h.text)}${h.q > 1 ? ` <span class="tag">×${h.q}</span>` : ''}</div>
        <div class="tag">${h.boxMatch ? 'box' : 'in ' + esc(h.b.name || 'Box ' + h.b.id)}${h.b.location ? ' · ' + esc(h.b.location) : ''}</div></div>
        ${h.t ? `<img class="hp" src="${h.t}" alt="">` : ''}
      </a>`).join('')}</div>` : `<div class="empty">Nothing matches “${esc(term)}”.</div>`;
  };
  input.addEventListener('input', draw); draw();
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
  if (focus) input.focus();
}
function boxCard(b) {
  const its = itemsOf(b.id);
  const peek = its.filter(i => i.n).slice(0, 4).map(i => i.n).join(' · ');
  const cover = b.cover || its.find(i => i.t)?.t;
  return `<a class="box card" href="#/box/${encodeURIComponent(b.id)}">
    ${cover ? `<img class="thumb" src="${cover}" alt="">` : ''}
    <div class="num"><small>№</small>${esc(b.id)}</div>
    <h3>${esc(b.name || 'Untitled box')}</h3>
    <div class="meta tag">${its.length} item${its.length === 1 ? '' : 's'}${b.location ? ' · ' + esc(b.location) : ''}</div>
    ${peek ? `<div class="peek">${esc(peek)}</div>` : ''}
  </a>`;
}
function viewMissing(id) {
  app.innerHTML = `<div class="card panel" style="max-width:560px;margin:30px auto;text-align:center">
    <div class="bignum" style="font-size:150px">${esc(id)}</div>
    <h2 style="justify-content:center;margin-top:14px">BOX ${esc(id)} IS EMPTY</h2>
    <p style="margin:6px 0 18px">This label hasn’t been set up yet.</p>
    <button class="btn hot big" id="mk">Set up Box ${esc(id)}</button></div>`;
  $('#mk').onclick = () => { createBox(id); viewBox(id); };
}

function viewBox(id) {
  const b = byId(id);
  if (!b) return viewMissing(id);
  watchBoxPhotos(id);
  const items = itemsOf(id), photos = boxPhotos.get(id) || [];
  const opts = k => [...new Set(sorted().map(x => x[k]).filter(Boolean))].map(v => `<option value="${esc(v)}">`).join('');
  app.innerHTML = `
    <div class="head">
      <div class="bignum">${esc(b.id)}</div>
      <div>
        <div class="tag">Box name</div>
        <input class="field name" data-f="name" placeholder="e.g. Winter clothes" value="${esc(b.name)}">
        <div class="row" style="margin-top:12px;gap:16px">
          <div style="flex:1;min-width:140px"><div class="tag">Where it lives</div><input class="field" data-f="location" placeholder="Loft · left side" value="${esc(b.location)}" list="locs"></div>
          <div style="flex:1;min-width:140px"><div class="tag">Category</div><input class="field" data-f="category" placeholder="Clothes" value="${esc(b.category)}" list="cats"></div>
        </div>
      </div>
    </div>
    <datalist id="locs">${opts('location')}</datalist><datalist id="cats">${opts('category')}</datalist>
    <div class="cols">
      <section class="card panel">
        <h2>INSIDE <span class="tag">${items.length} items</span></h2>
        <label class="snap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M3 8h4l2-3h6l2 3h4v12H3z"/><circle cx="12" cy="13.5" r="3.8"/></svg>
          SNAP AN ITEM
          <input type="file" accept="image/*" capture="environment" multiple id="snapi" hidden>
        </label>
        <form class="add" id="addf">
          <input class="field" id="addi" placeholder="…or type: towels, 3x mugs" autocomplete="off">
          <button class="btn hot">Add</button>
        </form>
        <ul class="items" id="items">${items.map(it => `
          <li>${it.t ? `<img class="it-ph" src="${it.t}" data-iv="${it.id}" alt="">` : `<label class="it-add" title="Add photo">＋<input type="file" accept="image/*" capture="environment" data-ip="${it.id}" hidden></label>`}
            <input class="nm" data-nm="${it.id}" value="${esc(it.n)}" placeholder="Name this item…">
            ${it.q > 1 ? `<em class="q">×${it.q}</em>` : ''}<button class="x" data-del="${it.id}" aria-label="remove">✕</button></li>`).join('') || '<li class="tag" style="border:none">Nothing logged yet — snap your first item.</li>'}
        </ul>
        <label class="l"><div class="tag">Notes</div>
          <textarea class="field" data-f="notes" rows="2" placeholder="Fragile, open from top…">${esc(b.notes)}</textarea></label>
      </section>
      <section>
        <div class="card panel">
          <h2>PHOTOS <span class="tag">snap before sealing</span></h2>
          <label class="btn ink" style="display:inline-block">+ Add photo<input type="file" accept="image/*" multiple id="ph" hidden></label>
          <div class="photos">${photos.map(p => `<figure><img src="${p.t || p.p}" data-view="${p.id}" alt=""><button class="x" data-dp="${p.id}">✕</button></figure>`).join('')}</div>
        </div>
        <div class="card panel" style="margin-top:22px">
          <h2>LABEL</h2>
          <div class="qrmini"><div class="q">${qrSvg(boxUrl(b.id))}</div>
            <div style="min-width:0"><div class="tag" style="word-break:break-all">${esc(boxUrl(b.id))}</div>
            <div class="row" style="margin-top:10px"><a class="btn" href="#/labels?only=${encodeURIComponent(b.id)}">Print label</a></div></div></div>
        </div>
        <div class="row" style="margin-top:22px;justify-content:flex-end">
          <button class="btn danger" id="delbox">Delete box</button>
        </div>
      </section>
    </div>`;

  if (pendingFocus) { app.querySelector(`[data-nm="${pendingFocus}"]`)?.focus(); pendingFocus = null; }

  app.querySelectorAll('[data-f]').forEach(el => el.addEventListener('change', () => setBox(id, { [el.dataset.f]: el.value.trim() })));
  $('#addf').onsubmit = e => {
    e.preventDefault();
    const parts = $('#addi').value.split(/[,\n]/).map(parseItem).filter(Boolean);
    if (!parts.length) return;
    parts.forEach(p => addItem(id, p));
    viewBox(id); $('#addi').focus();
  };
  $('#snapi').onchange = async e => {
    const files = [...e.target.files]; if (!files.length) return;
    toast(files.length > 1 ? `Adding ${files.length} items…` : 'Adding item…');
    let first = null;
    for (const f of files) { const iid = addItem(id, await photo(f)); first ??= iid; }
    pendingFocus = first; viewBox(id);
  };
  const list = $('#items');
  const itemOf = iid => itemsM.get(iid);
  list.onclick = e => {
    const t = e.target;
    if (t.dataset.del) {
      const it = itemOf(t.dataset.del); if (!it) return;
      if ((it.t || it.n) && !confirm(`Remove “${it.n || 'this item'}”?`)) return;
      delItem(it); return viewBox(id);
    }
    if (t.dataset.iv) { const it = itemOf(t.dataset.iv); lightbox(it.t, it.img ? () => fullImage(it.img) : null); }
  };
  list.onchange = async e => {
    const t = e.target;
    if (t.dataset.ip && t.files[0]) { setItemPhoto(itemOf(t.dataset.ip), await photo(t.files[0])); return viewBox(id); }
    if (t.dataset.nm) renameItem(itemOf(t.dataset.nm), t.value);
  };
  list.onkeydown = e => {
    if (e.key !== 'Enter' || !e.target.dataset.nm) return;
    e.preventDefault();
    const next = [...list.querySelectorAll('.nm')].find(x => !x.value && x !== e.target);
    next ? next.focus() : e.target.blur();
  };
  $('#ph').onchange = async e => {
    toast('Adding photo…');
    for (const f of e.target.files) addBoxPhoto(id, await photo(f));
    viewBox(id);
  };
  app.querySelector('.photos').onclick = e => {
    const ph = photos.find(p => p.id === (e.target.dataset.dp || e.target.dataset.view)); if (!ph) return;
    if (e.target.dataset.dp) { if (confirm('Remove this photo?')) delBoxPhoto(id, ph); return; }
    lightbox(ph.p || ph.t);
  };
  $('#delbox').onclick = async () => {
    if (!confirm(`Delete Box ${b.id} and everything logged in it? This can’t be undone.`)) return;
    await delBox(b.id); location.hash = '#/';
  };
}

function viewLabels(params) {
  const only = params.get('only');
  const list = sorted();
  const sel = new Set(only ? [only] : list.map(b => b.id));
  app.innerHTML = `
    <div class="card lab-ctrl">
      <h2 style="font-family:var(--stencil);font-size:30px;margin-bottom:8px">PRINT LABELS</h2>
      <div class="row"><span class="tag">Boxes:</span>
        ${list.map(b => `<label class="chk"><input type="checkbox" value="${esc(b.id)}" ${sel.has(b.id) ? 'checked' : ''}> ${esc(b.id)}</label>`).join('') || '<span class="tag">none yet</span>'}
      </div>
      <div class="row"><span class="tag">Or blank labels:</span>
        <input class="field" id="from" type="number" inputmode="numeric" min="1" value="${list.length ? '' : 1}" placeholder="from" style="width:80px">
        <input class="field" id="to" type="number" inputmode="numeric" min="1" value="${list.length ? '' : 12}" placeholder="to" style="width:80px">
        <span class="tag">— scan a blank one later to set it up</span>
      </div>
      <div class="row"><span class="tag">Size:</span>
        <label class="chk"><input type="radio" name="sz" value="l" checked> Large (2 / row)</label>
        <label class="chk"><input type="radio" name="sz" value="s"> Small (3 / row)</label>
        <button class="btn hot" id="pr" style="margin-left:auto">Print</button>
      </div>
    </div>
    <div class="sheet" id="sheet"></div>`;
  const draw = () => {
    const ids = [...app.querySelectorAll('.chk input[type=checkbox]:checked')].map(i => i.value);
    const f = parseInt($('#from').value), t = parseInt($('#to').value);
    if (f && t && t >= f && t - f < 300) for (let n = f; n <= t; n++) { const id = pad(n); if (!ids.includes(id)) ids.push(id); }
    ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const sheet = $('#sheet');
    sheet.className = 'sheet' + (app.querySelector('[name=sz]:checked').value === 's' ? ' s' : '');
    sheet.innerHTML = ids.map(id => { const b = byId(id); return `
      <div class="label"><div class="q">${qrSvg(boxUrl(id))}</div>
        <div><div class="ln">${esc(id)}</div>
        ${b?.name ? `<div class="lt">${esc(b.name)}</div>` : '<div class="blank-line"></div>'}
        <div class="lb">Scan to see inside</div></div></div>`; }).join('')
      || '<div class="empty" style="grid-column:1/-1">Pick boxes or a blank range.</div>';
  };
  app.querySelector('.lab-ctrl').addEventListener('input', draw);
  $('#pr').onclick = () => window.print();
  draw();
}

async function doMigrate() {
  if (!confirm(`Copy ${legacy.length} box(es) from this phone into the cloud?`)) return;
  const n = await migrate(legacy);
  localStorage.setItem('bb-migrated-' + homeId, '1');
  toast(`Done — ${n} boxes are in the cloud`); render();
}

function viewData() {
  const members = home?.members || [];
  const isMig = legacy.length && !localStorage.getItem('bb-migrated-' + homeId);
  app.innerHTML = `<div class="data">
    <section class="card panel">
      <h2>ACCOUNT</h2>
      <p>Signed in as <b>${esc(user.email)}</b>. Everything is saved to the cloud, and kept on this phone for offline use.</p>
      <div class="row"><button class="btn" id="out">Sign out</button></div>
    </section>
    <section class="card panel">
      <h2>FAMILY ACCESS <span class="tag">${members.length} / 20</span></h2>
      <p>Anyone listed here can sign in with that email and see and edit every box.</p>
      <ul class="members">${members.map(m => `<li><span>${esc(m)}</span>${m === home.ownerEmail ? '<em class="tag">owner</em>' : `<button class="x" data-rm="${esc(m)}" aria-label="remove">✕</button>`}</li>`).join('')}</ul>
      <form class="add" id="invf" style="margin-top:12px"><input class="field" type="email" id="inv" placeholder="husband@gmail.com" required><button class="btn hot">Add</button></form>
      ${homes.length > 1 ? `<label class="l"><div class="tag">Switch home</div><select class="field" id="sw">${homes.map(h => `<option value="${h.id}" ${h.id === homeId ? 'selected' : ''}>${esc(h.ownerEmail || h.id)}’s home</option>`).join('')}</select></label>` : ''}
    </section>
    ${isMig ? `<section class="card panel"><h2>ON THIS PHONE ONLY</h2><p>${legacy.length} box(es) from the old version are saved only on this phone.</p><button class="btn hot" id="mig">Move to cloud</button></section>` : ''}
    <section class="card panel">
      <h2>EXTRA BACKUP</h2>
      <p>Optional: download everything, photos included, as one file to keep in Drive.</p>
      <div class="row"><button class="btn ink" id="ex">Download backup</button>
        <label class="btn">Restore file<input type="file" accept="application/json,.json" id="im" hidden></label></div>
    </section>
    <section class="card panel">
      <h2>QR LINK BASE</h2>
      <p>Labels point to this address + <code>#/box/07</code>. Leave blank to use this page.</p>
      <input class="field" id="base" placeholder="${esc(location.origin + location.pathname)}" value="${esc(localStorage.getItem('bb-base') || '')}">
      <div class="row" style="margin-top:12px"><button class="btn" id="sb">Save</button></div>
    </section></div>`;

  $('#out').onclick = () => signOut(auth);
  $('#invf').onsubmit = e => {
    e.preventDefault();
    const em = $('#inv').value.trim().toLowerCase();
    if (members.includes(em)) return toast('Already added');
    home.members = [...members, em];
    w(updateDoc(doc(db, 'homes', homeId), { members: arrayUnion(em) }));
    toast(`Added — ${em} can now sign in`); viewData();
  };
  app.querySelector('.members').onclick = e => {
    const em = e.target.dataset.rm; if (!em || !confirm(`Remove ${em}?`)) return;
    home.members = members.filter(m => m !== em);
    w(updateDoc(doc(db, 'homes', homeId), { members: arrayRemove(em) })); viewData();
  };
  $('#sw')?.addEventListener('change', e => { localStorage.setItem('bb-home-' + user.uid, e.target.value); location.reload(); });
  $('#mig')?.addEventListener('click', doMigrate);
  $('#ex').onclick = async () => {
    toast('Preparing backup…');
    try {
      const imgs = await getDocs(col('images'));
      const data = { app: 'boxbase', v: 2, at: new Date().toISOString(), boxes: sorted(), items: [...itemsM.values()], images: imgs.docs.map(d => ({ id: d.id, ...d.data() })) };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      a.download = `boxbase-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    } catch (e) { fail(e); }
  };
  $('#im').onchange = async e => {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (data.v === 2) {
        if (!confirm(`Restore ${data.boxes.length} boxes? Boxes with the same number will be overwritten.`)) return;
        const put = (n, { id, ...rest }) => w(setDoc(ref(n, id), rest));
        data.boxes.forEach(x => put('boxes', x)); data.items.forEach(x => put('items', x)); data.images.forEach(x => put('images', x));
        toast('Restored'); location.hash = '#/';
      } else if (Array.isArray(data.boxes)) {
        if (!confirm(`Import ${data.boxes.length} boxes from an old backup?`)) return;
        await migrate(data.boxes); location.hash = '#/';
      } else throw 0;
    } catch (err) { if (err) console.error(err); toast('That file isn’t a BOXBASE backup'); }
  };
  $('#sb').onclick = () => { const v = $('#base').value.trim(); v ? localStorage.setItem('bb-base', v) : localStorage.removeItem('bb-base'); toast('Saved'); };
}

/* ================= router ================= */
function route() {
  const [path, qs] = location.hash.slice(1).split('?');
  const parts = (path || '/').split('/').filter(Boolean);
  return { name: parts[0] || 'home', parts, params: new URLSearchParams(qs || '') };
}
function bar(name, parts) {
  const titles = { labels: 'LABELS', data: 'ACCOUNT', search: 'FIND' };
  $('#bar').innerHTML = name === 'box'
    ? `<a class="back" href="#/"><b>‹</b> Boxes</a><span class="sync" id="sync"></span><span class="ttl">BOX ${esc(decodeURIComponent(parts[1] || ''))}</span>`
    : `<a class="logo" href="#/">BOX<span>BASE</span></a><span class="sync" id="sync"></span>${titles[name] ? `<span class="ttl sub" style="color:#9b9183">${titles[name]}</span>` : ''}`;
  drawSync();
}
function render(soft = false) {
  const { name, parts, params } = route();
  const signedIn = configured && user && user.emailVerified;
  document.body.classList.toggle('auth', !signedIn);
  if (!configured) return viewSetup();
  if (!user) return viewLogin();
  if (!user.emailVerified) return viewVerify();
  const tab = name === 'box' || name === 'new' ? 'home' : name;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === tab));
  bar(name, parts);
  if (!soft) window.scrollTo(0, 0);
  if (!booted) { app.innerHTML = '<div class="empty">Opening your boxes…</div>'; return; }
  if (name === 'new') { const id = createBox(); location.replace('#/box/' + id); return; }
  if (name === 'box') return viewBox(decodeURIComponent(parts[1] || ''));
  if (name === 'labels') return viewLabels(params);
  if (name === 'data') return viewData();
  viewHome(name === 'search' && !soft);
}

async function start(u) {
  teardown(); user = u;
  if (!u || !u.emailVerified) return render();
  render();
  try { await pickHome(); }
  catch (e) {
    console.error(e);
    app.innerHTML = `<div class="empty">Couldn’t open your boxes.<br>${esc(e.message)}<br><br><button class="btn" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  listen();
}

window.addEventListener('hashchange', () => render());
navigator.storage?.persist?.();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
readLegacy().then(l => { legacy = l; if (booted) render(true); });
if (configured) onAuthStateChanged(auth, start); else render();
