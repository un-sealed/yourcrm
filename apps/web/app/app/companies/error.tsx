"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the companies list, with retry. */
export default function CompaniesError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("companies list failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading companies."}
      onRetry={reset}
    />
  )
}
