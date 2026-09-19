"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the CS account detail page, with retry. */
export default function CustomerSuccessAccountError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("customer success account detail failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this account."}
      onRetry={reset}
    />
  )
}
