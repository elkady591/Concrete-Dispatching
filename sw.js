/* Pour Tracker service worker — makes the installed PWA open OFFLINE and load instantly.
   Strategy:
   - Cross-origin requests (the live Google Sheets data) are NEVER touched -> always straight to the network.
   - Same-origin navigations (the app shell) are NETWORK-FIRST: always fetch the latest build when online
     (so the built-in self-update keeps working), and fall back to the cached shell only when offline.
   - Static assets (icons/manifest) are cache-first for speed.
   Bump CACHE only when this file itself changes. */
const CACHE = 'pourtracker-v3';
const SHELL = [
  './index.html', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png',
  './icons/favicon-32.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.map(k => (k === CACHE || !k.startsWith('pourtracker-')) ? null : caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // live data -> let it go to the network untouched

  const isNav = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isNav) {
    // network-first: newest build wins; cache a clean copy under a stable key for the offline fallback
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return res; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  // static assets: cache-first, refresh in the background
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res;
    }))
  );
});

/* ---------- notifications ----------
   A push arrives even when the app is closed. Its payload (when there is one) is JSON
   {title, body, tag, url}; a push with no payload still shows a generic "open the app" note. */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { try { d = { body: e.data.text() }; } catch (__) {} }
  e.waitUntil(self.registration.showNotification(d.title || 'Concrete Dispatching', {
    body: d.body || 'There is something new to review — open the app.',
    icon: './icons/icon-192.png',
    badge: './icons/favicon-32.png',
    tag: d.tag || undefined,          // same tag = replaces the earlier note instead of stacking
    renotify: !!d.tag,
    data: { url: d.url || '', k: d.k || '' }
  }));
});

// Tapping the note: go straight to the problem — All Pours with that element's truck log open.
// The "where to go" is left in a tiny cache entry (INTENT) that the app reads when it opens or comes back
// to the front, and is also posted to any app page that is already running. Then an open window is
// focused, or the app is opened. (A normal start of the app has no intent and still lands on Summary.)
const INTENT = 'pt-intent';
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};
  const scope = self.registration.scope, origin = new URL(scope).origin;
  e.waitUntil((async () => {
    try { const c = await caches.open(INTENT); await c.put('intent', new Response(JSON.stringify({ k: d.k || '', at: Date.now() }))); } catch (_) {}
    const cs = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    cs.filter(c => c.url.startsWith(scope)).forEach(c => { try { c.postMessage({ type: 'open-check', k: d.k || '' }); } catch (_) {} });
    const open = cs.find(c => c.url.startsWith(origin) && c.url.indexOf('/Concrete-Management/') > 0)
              || cs.find(c => c.url.startsWith(scope));
    if (open && 'focus' in open) return open.focus();
    return clients.openWindow(d.url || scope);
  })());
});
