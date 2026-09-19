"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the campaigns list, with retry. */
export default function MarketingCampaignsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("campaigns list failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading campaigns."}
      onRetry={reset}
    />
  )
}
