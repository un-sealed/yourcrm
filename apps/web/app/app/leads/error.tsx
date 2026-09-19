"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the leads list, with retry. */
export default function LeadsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("leads list failed", error)
  }, [error])

  return (
    <ErrorState message={error.message || "Something went wrong loading leads."} onRetry={reset} />
  )
}
