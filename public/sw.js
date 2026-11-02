// Cache only the public app shell. Online gameplay always requires the server.
const CACHE = 'duo-arena-shell-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/ws')) return;
  if (url.pathname === '/' || url.pathname.startsWith('/invite/')) {
    event.respondWith(fetch(event.request).catch(() => caches.match('/index.html'))); return;
  }
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
