import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the marketing overview: preserves the layout. */
export default function MarketingLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading marketing">
      <Skeleton className="h-7 w-48" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    </div>
  )
}
