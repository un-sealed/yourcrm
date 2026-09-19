// Hand-written service worker — no Workbox, no next-pwa (see AGENTS.md /
// the mobile-pwa module's hard rules: this module may not add a
// dependency). Registered from `components/service-worker-register.tsx`.
//
// Caching policy
// ---------------
// - Navigations (HTML documents) are network-first: try the network, cache
//   a copy of what comes back, and on failure fall back to the last cached
//   copy of that same URL, then to /offline.html. That's what makes "open
//   a page you've already visited, then go offline" work.
// - Same-origin build assets under /_next/static/ are content-hashed and
//   immutable, so they're cache-first.
// - Everything else same-origin (manifest, icons, fonts) is
//   stale-while-revalidate: serve the cached copy instantly if there is
//   one, and refresh the cache in the background.
// - Anything whose path contains "/api/" is excluded from every cache path
//   above, in both directions — see `isApiRequest` below for why.
//
// Why /api/ is excluded (read this before "optimizing" it away)
// ----------------------------------------------------------------
// `apps/web/lib/api-client.ts` calls the API two different ways depending
// on environment: through the Next.js same-origin rewrite at `/api/*`
// (next.config.mjs), or straight at NEXT_PUBLIC_API_URL, which is commonly
// a different origin/port (see lib/env.ts — defaults to
// http://localhost:4000). A `fetch` event fires for both, same-origin and
// cross-origin, as long as the page that issued it is under this SW's
// scope. Either way the path is always "/api/v1/...", so matching on
// `url.pathname.includes("/api/")` catches both.
//
// Every one of those responses is workspace- and user-scoped CRM data,
// authenticated by an httpOnly session cookie the SW cannot see or key
// its cache on. Caching it would risk serving one signed-in user's people/
// deals/invoices to whoever uses the browser/device next — a stronger
// version of the "never serve stale CRM data" rule this module exists to
// enforce. So API requests are not just "network-first with a cache
// fallback", they are never handed to `caches` at all: no `event.respondWith`
// is called for them, which means the browser performs its own ordinary,
// uncached fetch. If that fetch fails offline, the rejection propagates to
// `apiFetchRaw`/`apiFetch` exactly like any other network error, and the
// app's existing ApiError / ErrorState / toast handling takes over — no
// stale data is ever substituted for a failed read.
//
// Mutating requests (POST/PUT/PATCH/DELETE) are further guaranteed to
// never even reach this file while offline: `lib/api-client.ts` refuses
// them up front (see the comment there) so there is nothing for the SW to
// intercept in the first place.

// Cache predicates (isApiRequest, isBuildAsset) live in sw-cache-policy.js,
// loaded as a classic script so `apps/web/lib/sw-cache-policy.test.ts` can
// evaluate that exact file and exercise the real predicate — see its
// header comment.
importScripts("/sw-cache-policy.js")

const VERSION = "v1"
const SHELL_CACHE = `yourcrm-shell-${VERSION}`
const RUNTIME_CACHE = `yourcrm-runtime-${VERSION}`
const OFFLINE_URL = "/offline.html"
const PRECACHE_URLS = [OFFLINE_URL, "/manifest.webmanifest"]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", (event) => {
  const { request } = event
  if (request.method !== "GET") {
    return
  }

  const url = new URL(request.url)

  if (isApiRequest(url)) {
    return
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request))
    return
  }

  if (url.origin !== self.location.origin) {
    return
  }

  if (isBuildAsset(url)) {
    event.respondWith(cacheFirst(request))
    return
  }

  event.respondWith(staleWhileRevalidate(request))
})

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const response = await fetch(request)
    cache.put(request, response.clone())
    return response
  } catch {
    const cached = await cache.match(request)
    return cached ?? (await cache.match(OFFLINE_URL)) ?? Response.error()
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE)
  const cached = await cache.match(request)
  if (cached) {
    return cached
  }
  const response = await fetch(request)
  if (response.ok) {
    cache.put(request, response.clone())
  }
  return response
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE)
  const cached = await cache.match(request)
  const network = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone())
      }
      return response
    })
    .catch(() => undefined)
  return cached ?? (await network) ?? Response.error()
}
