"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the pipelines list, with retry. */
export default function PipelinesError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("pipelines list failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading pipelines."}
      onRetry={reset}
    />
  )
}
