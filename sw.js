// Minimal service worker: makes the app installable and caches the shell.
const CACHE = "spindle-v1";
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(["/", "/static/icon-192.png"])));
  self.skipWaiting();
});
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/search")) return; // never cache API calls
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
