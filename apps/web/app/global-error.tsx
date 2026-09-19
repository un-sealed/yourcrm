"use client"

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen flex-col items-center justify-center p-8 text-center">
          <h1 className="text-2xl font-semibold">YourCRM crashed</h1>
          <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
          <button
            onClick={reset}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  )
}
