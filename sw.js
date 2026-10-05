/* Ludo with Friends — service worker (PWA foundation, NATIVE-APPS-PLAN §4.1).

   Design rules — this file must never break live users or the Playwright E2E suite:
   1. Navigations are NETWORK-FIRST with a cache fallback, so a deploy is never
      sticky: the browser revalidates the document on every load and the fresh
      copy replaces the cached one.
   2. Only a tiny, hard-coded list of same-origin static assets is served
      cache-first (with a background revalidation).
   3. Everything cross-origin (gstatic Firebase modules, identitytoolkit,
      firestore.googleapis.com, …) is NOT intercepted at all — we `return`
      without calling respondWith and let the browser handle it.
   4. Only GET responses are ever cached. Writes/POSTs are never touched.
   5. Any failure falls through to the network rather than erroring the page. */

const VERSION = 'v1';
const CACHE = 'ludo-' + VERSION;

// Precache: local static shell only. Kept deliberately small.
const PRECACHE = [
  './',
  './index.html',
  './firebase-config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

// Same-origin GET paths that may be cached. Nothing else is ever stored.
function isStaticPath(pathname) {
  return (
    pathname.endsWith('/manifest.webmanifest') ||
    pathname.endsWith('/firebase-config.js') ||
    pathname.indexOf('/icons/') !== -1
  );
}

/* ------------------------------------------------------------------ install */
self.addEventListener('install', function (event) {
  event.waitUntil(
    (async function () {
      const cache = await caches.open(CACHE);
      // Individual failures must not block activation (e.g. a missing icon).
      await Promise.all(
        PRECACHE.map(function (url) {
          return cache.add(new Request(url, { cache: 'reload' })).catch(function () {});
        })
      );
      // Safe: navigations are network-first, so skipping the waiting state can
      // never pin an old document in front of a user.
      await self.skipWaiting();
    })()
  );
});

/* ----------------------------------------------------------------- activate */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(function (key) { return key.indexOf('ludo-') === 0 && key !== CACHE; })
          .map(function (key) { return caches.delete(key); })
      );
      await self.clients.claim();
    })()
  );
});

/* -------------------------------------------------------------------- fetch */
self.addEventListener('fetch', function (event) {
  const req = event.request;

  // Never intercept or cache anything that is not a GET (no writes, ever).
  if (req.method !== 'GET') return;

  // Cross-origin (Firebase SDK, auth, Firestore): leave entirely to the browser.
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // Document navigations → NETWORK-FIRST, cache fallback, cache on success.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstDocument(req));
    return;
  }

  // Same-origin static shell → cache-first with background refresh (SWR).
  if (isStaticPath(url.pathname)) {
    event.respondWith(cacheFirstRevalidate(req, event));
    return;
  }

  // Any other same-origin GET: do not intercept; browser default applies.
  return;
});

/* -------------------------------------------------------- navigation handler */
async function networkFirstDocument(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    // Cache successful responses only — a 4xx/5xx must never become the fallback.
    if (res && res.ok) {
      try { await cache.put(req, res.clone()); } catch (e) { /* quota/ttp error: ignore */ }
    }
    return res;
  } catch (err) {
    const cached =
      (await cache.match(req, { ignoreSearch: false })) ||
      (await cache.match(req, { ignoreSearch: true })) ||
      (await cache.match('./index.html')) ||
      (await cache.match('./'));
    if (cached) return cached;
    throw err;
  }
}

/* ------------------------------------------------- static cache-first + SWR */
async function cacheFirstRevalidate(req, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);

  const refresh = fetch(req)
    .then(async function (res) {
      if (res && res.ok) {
        try { await cache.put(req, res.clone()); } catch (e) { /* ignore */ }
      }
      return res;
    })
    .catch(function () { return null; });

  if (cached) {
    // Serve from cache now; let the background refresh update the entry.
    if (event && event.waitUntil) event.waitUntil(refresh);
    return cached;
  }

  const res = await refresh;
  return res || Response.error();
}
