"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the person detail page, with retry. */
export default function PersonDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("person detail failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this person."}
      onRetry={reset}
    />
  )
}
