export default function RootLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div
        className="h-10 w-10 animate-spin rounded-full border-2 border-muted border-t-primary"
        aria-label="Loading"
      />
    </div>
  )
}
