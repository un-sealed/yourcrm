import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the marketplace catalogue: preserves the layout. */
export default function MarketplaceLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading marketplace">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-9 w-28" />
      </div>
      <Skeleton className="h-4 w-full max-w-xl" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((key) => (
          <Skeleton key={key} className="h-40 w-full" />
        ))}
      </div>
    </div>
  )
}
