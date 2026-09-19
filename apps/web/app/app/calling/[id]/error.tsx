"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the call detail page, with retry. */
export default function CallDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("call detail failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this call."}
      onRetry={reset}
    />
  )
}
