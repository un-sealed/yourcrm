// Pure caching predicates, split out of sw.js so they have a single
// source of truth that both the running service worker (via
// `importScripts`, below) and its test load and exercise directly —
// `apps/web/lib/sw-cache-policy.test.ts` reads and evaluates this exact
// file, so the test can never silently drift from what actually ships.
// No DOM/SW globals used here: keep these functions pure (URL in, boolean
// out) so they stay testable outside a service-worker context.

/**
 * True for any request under an API mount, same-origin or cross-origin.
 * `lib/api-client.ts` calls the API two ways depending on environment:
 * through the Next.js same-origin rewrite at `/api/*` (next.config.mjs),
 * or straight at NEXT_PUBLIC_API_URL (commonly a different origin/port,
 * see lib/env.ts). A `fetch` event fires for both, so this matches on
 * `pathname` alone rather than origin.
 */
function isApiRequest(url) {
  return url.pathname.includes("/api/")
}

/** Next.js build output: content-hashed and safe to cache-first. */
function isBuildAsset(url) {
  return url.pathname.startsWith("/_next/static/")
}

// Explicit exposure (rather than relying on implicit top-level-function
// hoisting onto the worker global) so it's obvious at a glance that
// `sw.js`'s `importScripts("/sw-cache-policy.js")` picks these up.
self.isApiRequest = isApiRequest
self.isBuildAsset = isBuildAsset
