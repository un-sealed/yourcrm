"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { isPortalUnauthorized, portalErrorMessage } from "./portal-client"

/**
 * One fetch, four states: loading, error (retryable), empty and loaded.
 *
 * Every portal page needs the same four, and a 401 always means the same
 * thing here — the cookie expired or was revoked while the page was open —
 * so the hook sends the customer back to sign in rather than leaving a dead
 * screen. No member-session logic exists on this path.
 */
export type PortalResourceState<T> = {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

export function usePortalResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[] = [],
): PortalResourceState<T> {
  const router = useRouter()
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)

  // Callers define `load` inline, so its identity changes every render. The
  // `deps` they pass are the real inputs and drive the effect; the ref just
  // makes sure the effect always calls the freshest closure.
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    setLoading(true)
    setError(null)
    loadRef
      .current(controller.signal)
      .then((result) => {
        if (cancelled) return
        setData(result)
      })
      .catch((err: unknown) => {
        if (cancelled || controller.signal.aborted) return
        if (isPortalUnauthorized(err)) {
          router.push("/portal/login")
          return
        }
        setError(portalErrorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [attempt, router, ...deps])

  return { data, error, loading, reload: () => setAttempt((value) => value + 1) }
}
