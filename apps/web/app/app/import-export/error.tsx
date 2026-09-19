"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the import/export list, with retry. */
export default function ImportExportError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("import-export list failed", error)
  }, [error])

  return (
    <ErrorState
      message={error.message || "Something went wrong loading import/export jobs."}
      onRetry={reset}
    />
  )
}
