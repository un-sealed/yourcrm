"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the segment detail page, with retry. */
export default function MarketingSegmentDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("segment detail failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this segment."}
      onRetry={reset}
    />
  )
}
