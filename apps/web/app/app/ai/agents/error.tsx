"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the AI agents page, with retry. */
export default function AiAgentsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("ai agents page failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading your AI agents."}
      onRetry={reset}
    />
  )
}
