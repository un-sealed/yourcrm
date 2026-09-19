import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the quote detail page. */
export default function QuoteDetailLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading quote">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}
