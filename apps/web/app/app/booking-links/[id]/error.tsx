"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the booking link detail page, with retry. */
export default function BookingLinkDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("booking link detail failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this booking link."}
      onRetry={reset}
    />
  )
}
