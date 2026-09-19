"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the sequence list, with retry. */
export default function SequencesError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("sequence list failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading your sequences."}
      onRetry={reset}
    />
  )
}
