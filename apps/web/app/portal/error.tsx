"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/**
 * Portal error boundary. The message is deliberately vague: a customer-facing
 * error must not describe internal failures, and `error.message` from a
 * server component could.
 */
export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("portal page failed", error)
  }, [error])

  return <ErrorState message="Something went wrong loading this page." onRetry={reset} />
}
