"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the ticket list, with retry. */
export default function TicketsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("tickets list failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading tickets."}
      onRetry={reset}
    />
  )
}
