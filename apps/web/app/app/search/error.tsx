"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for global search, with retry. */
export default function SearchError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("global search failed", error)
  }, [error])

  return (
    <ErrorState message={error.message || "Something went wrong loading search."} onRetry={reset} />
  )
}
