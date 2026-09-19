"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the quote detail page, with retry. */
export default function QuoteDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("quote detail failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this quote."}
      onRetry={reset}
    />
  )
}
