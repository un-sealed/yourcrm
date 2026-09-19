"use client"

import { useEffect } from "react"

/**
 * Registers the hand-written `public/sw.js` (see that file for the caching
 * policy). Renders nothing; runs once on mount, client-side only.
 *
 * PRODUCTION ONLY — and that is not a preference, it is a correctness
 * requirement. `sw.js` treats `/_next/static/*` as content-hashed and
 * immutable and serves it cache-first. That holds for `next build`, but
 * `next dev` reuses stable chunk paths across rebuilds, so a dev install
 * pins the first JS it ever saw: the page navigates fresh (network-first),
 * renders the new UI for a frame, then stale cached chunks hydrate over it
 * and the old design wins. Editing the source appears to do nothing.
 *
 * In development we actively unregister any worker and drop its caches, so a
 * browser that already installed one heals itself on the next load instead
 * of needing a manual "Unregister" in devtools.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return
    }

    if (process.env.NODE_ENV !== "production") {
      void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
        await Promise.all(registrations.map((registration) => registration.unregister()))
        if (typeof caches !== "undefined") {
          const keys = await caches.keys()
          await Promise.all(keys.map((key) => caches.delete(key)))
        }
      })
      return
    }

    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.error("[sw] registration failed:", error)
    })
  }, [])

  return null
}
