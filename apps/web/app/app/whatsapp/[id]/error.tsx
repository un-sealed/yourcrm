"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for a WhatsApp conversation thread, with retry. */
export default function WhatsAppThreadError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("whatsapp conversation thread failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading this conversation."}
      onRetry={reset}
    />
  )
}
