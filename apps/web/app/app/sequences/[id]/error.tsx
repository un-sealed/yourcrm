"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for a sequence detail page, with retry. */
export default function SequenceDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("sequence detail failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this sequence."}
      onRetry={reset}
    />
  )
}
