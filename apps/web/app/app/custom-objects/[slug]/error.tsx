"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for a custom object page, with retry. */
export default function CustomObjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("custom object page failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this object."}
      onRetry={reset}
    />
  )
}
