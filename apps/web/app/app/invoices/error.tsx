"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the invoices list, with retry. */
export default function InvoicesError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("invoices list failed", error)
  }, [error])

  return (
    <ErrorState message={error.message || "Something went wrong loading invoices."} onRetry={reset} />
  )
}
