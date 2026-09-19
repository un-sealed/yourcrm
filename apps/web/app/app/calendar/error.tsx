"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the calendar views, with retry. */
export default function CalendarError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("calendar failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading the calendar."}
      onRetry={reset}
    />
  )
}
