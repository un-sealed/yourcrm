"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the onboarding page, with retry. */
export default function OnboardingError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("onboarding page failed", error)
  }, [error])

  return (
    <div className="mx-auto flex min-h-screen max-w-lg items-center p-8">
      <ErrorState
        message={error.message || "Something went wrong loading onboarding."}
        onRetry={reset}
      />
    </div>
  )
}
