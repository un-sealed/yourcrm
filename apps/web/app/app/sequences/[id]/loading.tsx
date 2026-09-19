import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for a sequence detail page: preserves the layout. */
export default function SequenceDetailLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading sequence">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-9 w-48" />
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}
