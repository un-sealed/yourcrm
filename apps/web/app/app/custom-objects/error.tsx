"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the custom-objects list, with retry. */
export default function CustomObjectsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("custom objects list failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading custom objects."}
      onRetry={reset}
    />
  )
}
