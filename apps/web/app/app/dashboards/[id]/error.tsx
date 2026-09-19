"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the dashboard detail page, with retry. */
export default function DashboardDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("dashboard detail failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this dashboard."}
      onRetry={reset}
    />
  )
}
