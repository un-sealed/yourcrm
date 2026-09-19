import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for global search: preserves the input + grouped layout. */
export default function SearchLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading search">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Skeleton className="h-9 w-full sm:max-w-xl" />
        <Skeleton className="h-9 w-full sm:w-56" />
      </div>
      <Skeleton className="h-3 w-48" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-14 w-full" />
      </div>
    </div>
  )
}
