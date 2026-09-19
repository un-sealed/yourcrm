"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the email thread detail page, with retry. */
export default function EmailThreadError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("email thread detail failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this thread."}
      onRetry={reset}
    />
  )
}
