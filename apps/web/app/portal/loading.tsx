import { Skeleton } from "@yourcrm/ui"

/** Portal loading skeleton: preserves the header + list layout. */
export default function PortalLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-4 w-64" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    </div>
  )
}
