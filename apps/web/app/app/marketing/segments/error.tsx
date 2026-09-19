"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the segments list, with retry. */
export default function MarketingSegmentsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("segments list failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading segments."}
      onRetry={reset}
    />
  )
}
