"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the knowledge base list, with retry. */
export default function KnowledgeBaseError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("knowledge base list failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading the knowledge base."}
      onRetry={reset}
    />
  )
}
