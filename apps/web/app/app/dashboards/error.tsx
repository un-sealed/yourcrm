"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the dashboards list, with retry. */
export default function DashboardsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("dashboards list failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading dashboards."}
      onRetry={reset}
    />
  )
}
