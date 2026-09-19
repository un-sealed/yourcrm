"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the unified inbox stream, with retry. */
export default function InboxError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("unified inbox stream failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading the inbox."}
      onRetry={reset}
    />
  )
}
