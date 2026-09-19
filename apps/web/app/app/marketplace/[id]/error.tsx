"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the app detail page, with retry. */
export default function MarketplaceAppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("marketplace app detail page failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this app."}
      onRetry={reset}
    />
  )
}
