/**
 * SERVICE WORKER RULES — read before modifying or re-registering.
 *
 * 1. Always include skipWaiting + clients.claim (see install/activate below).
 *    Without them, an updated SW sits in "waiting" state until every tab on
 *    the origin closes. In a dev context that never happens, and the hung SW
 *    blocks ALL fetch events for the origin — including navigation — making
 *    the site appear unreachable.
 *
 * 2. Never read response bodies (arrayBuffer / json / text) inside a fetch
 *    handler for the purpose of bookkeeping (e.g. measuring cache size).
 *    The SW runs on a single thread shared across every network request for
 *    this origin. Body reads on many entries block that thread and starve
 *    navigation requests. Use metadata (entry count, headers) instead.
 *
 * 3. Never call caches.open() inside a per-request handler. caches.open() is
 *    an async IndexedDB operation. Calling it once per tile request creates a
 *    queue of IDB operations that serializes all tile fetches — the globe will
 *    appear black for many seconds on initial load. Open the cache once at
 *    module scope and await the shared promise inside handlers.
 *
 * Recovery if the SW gets stuck: Firefox → about:debugging → This Firefox →
 * Service Workers → Unregister. Or clear all site data for the origin.
 */

const CACHE       = 'tiles-v1';
const MAX_ENTRIES = 2000;          // ~80-100MB at ~40-50KB per tile
const EVICT_COUNT = 400;           // drop this many oldest entries when over limit
const MAX_AGE     = 24 * 60 * 60 * 1000; // 24h

const TILE_ORIGINS = ['server.arcgisonline.com', 'gibs.earthdata.nasa.gov'];

// Open once at module scope — caches.open() is an IDB operation and must not
// be called per-request (see rule 3 above).
const tileCache = caches.open(CACHE);

// Pre-decoded 1×1 transparent PNG. Returned on network error so that
// TextureLoader's onLoad fires and three-slippy-map-globe's d.loading flag
// clears. Without this, failed tiles leave d.loading=true permanently, the
// tile mesh is never added to the scene, and the globe surface stays black.
const TRANSPARENT_1X1_PNG = (() => {
  const raw = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
})();

self.addEventListener('install', () => self.skipWaiting());

// On activate: delete any old/broken cache versions, then claim clients immediately.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => k !== CACHE && caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!TILE_ORIGINS.some(o => url.hostname.endsWith(o))) return;

  event.respondWith(handleTile(event.request));
});

async function handleTile(request) {
  const cache  = await tileCache;
  const cached = await cache.match(request);

  if (cached) {
    const age = Date.now() - Number(cached.headers.get('x-cached-at') ?? 0);
    if (age < MAX_AGE) return cached;
    // Stale: serve immediately, revalidate in background
    refreshTile(cache, request);
    return cached;
  }

  return fetchAndCache(cache, request);
}

async function fetchAndCache(cache, request) {
  let response;
  try {
    response = await fetch(request);
  } catch {
    return new Response(TRANSPARENT_1X1_PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
  }

  if (!response.ok) return response;

  const headers = new Headers(response.headers);
  headers.set('x-cached-at', String(Date.now()));

  // Clone before consuming body so we can return a fresh response
  const body = await response.arrayBuffer();
  cache.put(request, new Response(body, { status: 200, headers }));
  evictIfNeeded(cache); // fire-and-forget, count-only (no body reads)

  return new Response(body, { status: 200, headers: response.headers });
}

async function refreshTile(cache, request) {
  try { await fetchAndCache(cache, request); } catch (_) {}
}

async function evictIfNeeded(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_ENTRIES) return;
  // cache.keys() returns entries in insertion order — oldest first
  await Promise.all(keys.slice(0, EVICT_COUNT).map(k => cache.delete(k)));
}
