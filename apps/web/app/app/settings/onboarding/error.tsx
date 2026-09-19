"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the in-app onboarding checklist, with retry. */
export default function SettingsOnboardingError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("onboarding checklist failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading the onboarding checklist."}
      onRetry={reset}
    />
  )
}
