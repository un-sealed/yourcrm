import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the calling list: preserves the table layout. */
export default function CallingLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading calls">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-9 w-28" />
      </div>
      <Skeleton className="h-9 w-full max-w-md" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  )
}
