"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for a single report, with retry. */
export default function ReportError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("report page failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this report."}
      onRetry={reset}
    />
  )
}
