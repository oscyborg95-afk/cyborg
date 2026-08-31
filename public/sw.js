// Bumped on every strategy change so old clients drop their caches on activate.
const CACHE_NAME = "cod-desk-static-v2";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

// Content-hashed build output: safe to serve from cache forever, and what lets
// the app shell boot at all without a network.
const isImmutableAsset = (url) =>
  url.pathname.startsWith("/_next/static/") || PRECACHE.includes(url.pathname);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // Re-fetch rather than reuse anything a previous version left behind.
      .then((cache) => cache.addAll(PRECACHE.map((path) => new Request(path, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Page loads: always go to the network so auth redirects and live data behave
  // normally, and only fall back to the offline card when the network is gone.
  // Rendered HTML is never cached — it is per-tenant and per-session.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        // respondWith(undefined) would surface as a network error, so never let a
        // missing precache entry be worse than the page we are replacing.
        return (
          (await cache.match(OFFLINE_URL)) ||
          new Response("<h1>You're offline</h1>", {
            status: 503,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          })
        );
      })
    );
    return;
  }

  // Never let the worker sit between the app and its data.
  if (url.pathname.startsWith("/api/")) return;

  if (!isImmutableAsset(url)) return;

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            // Only store complete, same-origin successes — never opaque or error
            // responses, which would poison the cache until the next version.
            if (response.ok && response.type === "basic") {
              cache.put(request, response.clone());
            }
            return response;
          })
      )
    )
  );
});
