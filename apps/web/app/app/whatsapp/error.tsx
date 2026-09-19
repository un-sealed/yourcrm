"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the WhatsApp conversation list, with retry. */
export default function WhatsAppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("whatsapp conversation list failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading WhatsApp conversations."}
      onRetry={reset}
    />
  )
}
