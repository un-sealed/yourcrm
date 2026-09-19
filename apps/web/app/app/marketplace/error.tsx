"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the marketplace catalogue, with retry. */
export default function MarketplaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("marketplace page failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading the marketplace."}
      onRetry={reset}
    />
  )
}
