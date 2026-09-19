import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the unified inbox stream: preserves the layout. */
export default function InboxLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading inbox">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-5 w-56" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-9 w-44" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-9 w-40" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  )
}
