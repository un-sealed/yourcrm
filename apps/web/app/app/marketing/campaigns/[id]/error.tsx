"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the campaign detail page, with retry. */
export default function MarketingCampaignDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("campaign detail failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this campaign."}
      onRetry={reset}
    />
  )
}
