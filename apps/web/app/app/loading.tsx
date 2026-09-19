export default function AppLoading() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <div className="h-8 w-48 animate-pulse rounded-md bg-muted" />
      <div className="h-40 animate-pulse rounded-lg bg-muted" />
    </div>
  )
}
