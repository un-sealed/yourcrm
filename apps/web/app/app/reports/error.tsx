"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the reports list, with retry. */
export default function ReportsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("reports list failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading reports."}
      onRetry={reset}
    />
  )
}
