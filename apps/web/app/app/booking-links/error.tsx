"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the booking links list, with retry. */
export default function BookingLinksError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("booking links list failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading booking links."}
      onRetry={reset}
    />
  )
}
