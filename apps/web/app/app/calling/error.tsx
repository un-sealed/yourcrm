"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the calling list, with retry. */
export default function CallingError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("calling list failed", error)
  }, [error])

  return (
    <ErrorState message={error.message || "Something went wrong loading calls."} onRetry={reset} />
  )
}
