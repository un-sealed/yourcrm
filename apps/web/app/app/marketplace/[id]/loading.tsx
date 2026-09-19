import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the app detail page: preserves the layout. */
export default function MarketplaceAppLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading app">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  )
}
