"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the activities list, with retry. */
export default function ActivitiesError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("activities list failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading activities."}
      onRetry={reset}
    />
  )
}
