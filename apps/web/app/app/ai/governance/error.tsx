"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the AI approval queue, with retry. */
export default function AiGovernanceError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("ai governance page failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading the AI approval queue."}
      onRetry={reset}
    />
  )
}
