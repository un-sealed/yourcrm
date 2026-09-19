"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the assistant, with retry. */
export default function AiError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("ai assistant failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading the AI assistant."}
      onRetry={reset}
    />
  )
}
