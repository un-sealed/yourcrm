import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the segment detail page. */
export default function MarketingSegmentDetailLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading segment">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}
