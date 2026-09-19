"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for conversation intelligence, with retry. */
export default function ConversationIntelligenceError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // The message is already redacted of conversation content by the
    // domain service — see packages/crm/src/conversation-intelligence.
    console.error("conversation intelligence failed", error.message)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading conversation intelligence."}
      onRetry={reset}
    />
  )
}
