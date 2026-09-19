"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the automation pages, with retry. */
export default function AutomationError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("automation page failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading automations."}
      onRetry={reset}
    />
  )
}
