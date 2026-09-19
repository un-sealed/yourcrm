"use client"

import { useEffect, useState } from "react"
import { isOffline } from "@/lib/offline"

/**
 * Sitewide "you're offline" indicator. Starts `false` (matches SSR, which
 * has no `navigator`) and syncs to the real state after mount, then tracks
 * the browser's `online`/`offline` events — this is the visible half of
 * the offline-write contract: before a write is ever attempted, the user
 * already knows why it might fail. See `lib/api-client.ts` for the refusal
 * itself.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    setOffline(isOffline())
    const handleOnline = () => setOffline(false)
    const handleOffline = () => setOffline(true)
    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)
    return () => {
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [])

  if (!offline) {
    return null
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-b border-amber-300 bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      You&rsquo;re offline. Pages you&rsquo;ve already opened stay available — changes can&rsquo;t
      be saved until you reconnect.
    </div>
  )
}
