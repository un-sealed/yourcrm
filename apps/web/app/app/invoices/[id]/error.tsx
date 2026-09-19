"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the invoice detail page, with retry. */
export default function InvoiceDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("invoice detail failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this invoice."}
      onRetry={reset}
    />
  )
}
