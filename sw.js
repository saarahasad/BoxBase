// BOXBASE offline cache — bump VERSION after you update index.html
const VERSION = 'boxbase-v2';
const CORE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './app.js', './firebase-config.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // never touch Firebase/Google API traffic — Firestore handles its own offline cache
  const CACHEABLE = [location.origin, 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://www.gstatic.com', 'https://cdn.jsdelivr.net'];
  if (!CACHEABLE.includes(url.origin)) return;
  // pages + app code: network first so updates show; cache when offline
  if (e.request.mode === 'navigate' || (url.origin === location.origin && /\.(js|json)$/.test(url.pathname))) {
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(VERSION).then(x => x.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request).then(h => h || caches.match('./index.html'))));
    return;
  }
  // (old navigate branch kept below for safety) (so updates show), fall back to cache offline
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(r => { caches.open(VERSION).then(c => c.put('./index.html', r.clone())); return r; })
      .catch(() => caches.match('./index.html')));
    return;
  }
  // fonts, QR lib, icons: cache first
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return r;
  })));
});
