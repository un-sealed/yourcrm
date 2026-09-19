"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the company detail page, with retry. */
export default function CompanyDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("company detail failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this company."}
      onRetry={reset}
    />
  )
}
