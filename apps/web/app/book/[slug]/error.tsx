"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the public booking page, with retry. */
export default function PublicBookingError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("public booking page failed", error)
  }, [error])

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center p-8">
      <ErrorState
        message={error.message || "Something went wrong loading this booking page."}
        onRetry={reset}
      />
    </div>
  )
}
