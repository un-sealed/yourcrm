"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the marketing overview, with retry. */
export default function MarketingError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("marketing overview failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading marketing."}
      onRetry={reset}
    />
  )
}
