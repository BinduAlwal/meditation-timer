// Meditation Timer — service worker
// Cache-first strategy: app shell + audio is cached on install,
// so the PWA works fully offline after the first load.

const CACHE_VERSION = 'meditation-v5';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './audio/bell.wav',
  './audio/bowl.wav',
  './audio/gong.wav',
  './audio/wood.wav',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      // addAll is atomic — if any file fails, install fails.
      // Use individual add() with catch so a missing optional file doesn't break install.
      return Promise.all(
        APP_SHELL.map(url =>
          cache.add(url).catch(err => console.warn('SW: failed to cache', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        // Only cache successful same-origin responses
        if (res.ok && new URL(req.url).origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(req, copy));
        }
        return res;
      }).catch(() => {
        // Offline fallback: if the request is for a navigation, return the cached index
        if (req.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
