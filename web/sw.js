/* Offline shell for the PWA. Live data always comes from the network. */

const CACHE = 'crc-shell-v7';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/dom.js',
  '/icons.js',
  '/feed-view.js',
  '/markdown.js',
  // Imported on demand when someone presses Scan — which may well be the
  // moment they have no working connection to fetch it over.
  '/scanner.js',
  '/voice.js',
  '/i18n.js',
  '/qr-decode.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Sessions, feeds and the socket must never be served from cache.
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html').then((r) => r || Response.error())),
    );
    return;
  }

  // Network-first: the daemon is on the local network, so freshness is cheap and
  // a stale app.js after an upgrade is worse than a few milliseconds of latency.
  // The cache is the offline fallback, not the primary source.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || Response.error())),
  );
});

// Tapping a permission alert should bring the app forward, not open a new tab.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});
