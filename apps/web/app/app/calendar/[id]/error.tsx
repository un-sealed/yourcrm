"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the calendar event detail page, with retry. */
export default function CalendarEventDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("calendar event detail failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this event."}
      onRetry={reset}
    />
  )
}
