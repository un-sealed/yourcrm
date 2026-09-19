"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the email thread list, with retry. */
export default function EmailError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("email thread list failed", error)
  }, [error])

  return (
    <ErrorState message={error.message || "Something went wrong loading email."} onRetry={reset} />
  )
}
