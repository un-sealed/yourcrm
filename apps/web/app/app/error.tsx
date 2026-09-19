"use client"

export default function AppError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="rounded-lg border p-8 text-center">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
      <button
        onClick={reset}
        className="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
      >
        Try again
      </button>
    </div>
  )
}
