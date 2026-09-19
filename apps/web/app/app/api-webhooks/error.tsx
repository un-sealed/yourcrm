"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the API & webhooks page, with retry. */
export default function ApiWebhooksError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("api-webhooks page failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading API keys and webhooks."}
      onRetry={reset}
    />
  )
}
