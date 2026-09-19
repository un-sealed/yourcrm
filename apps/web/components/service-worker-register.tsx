"use client"

import { useEffect } from "react"

/**
 * Registers the hand-written `public/sw.js` (see that file for the caching
 * policy). Renders nothing; runs once on mount, client-side only, and is a
 * no-op in browsers without `serviceWorker` support.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return
    }
    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.error("[sw] registration failed:", error)
    })
  }, [])

  return null
}
