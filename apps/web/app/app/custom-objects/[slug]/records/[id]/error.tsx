"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for a custom record page, with retry. */
export default function CustomObjectRecordError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("custom record page failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this record."}
      onRetry={reset}
    />
  )
}
