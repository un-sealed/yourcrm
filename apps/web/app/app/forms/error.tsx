"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the forms list, with retry. */
export default function FormsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("forms list failed", error)
  }, [error])

  return (
    <ErrorState message={error.message || "Something went wrong loading forms."} onRetry={reset} />
  )
}
