"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for notification preferences, with retry. */
export default function NotificationPreferencesError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("notification preferences failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading notification preferences."}
      onRetry={reset}
    />
  )
}
