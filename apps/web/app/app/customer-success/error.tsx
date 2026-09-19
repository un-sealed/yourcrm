"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the CS account list, with retry. */
export default function CustomerSuccessError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("customer success list failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading customer success accounts."}
      onRetry={reset}
    />
  )
}
