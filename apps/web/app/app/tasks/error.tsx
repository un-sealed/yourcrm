"use client"

import { useEffect } from "react"
import { ErrorState } from "@yourcrm/ui"

/** Recoverable error boundary for the tasks list, with retry. */
export default function TasksError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("tasks list failed", error)
  }, [error])

  return (
    <ErrorState message={error.message || "Something went wrong loading tasks."} onRetry={reset} />
  )
}
