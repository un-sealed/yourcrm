"use client"

import { useEffect } from "react"

/**
 * Unsaved-change guard: warns on tab close/refresh while `dirty`.
 * (In-app navigation guards land with real forms in Phase 1.)
 */
export function useUnsavedGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [dirty])
}
