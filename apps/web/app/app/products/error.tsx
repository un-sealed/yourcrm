"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the products list, with retry. */
export default function ProductsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("products list failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading products."}
      onRetry={reset}
    />
  )
}
