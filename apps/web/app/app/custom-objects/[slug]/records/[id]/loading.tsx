import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for a custom record: header plus a field stack. */
export default function CustomObjectRecordLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading record">
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-9 w-full max-w-lg" />
      <Skeleton className="h-9 w-full max-w-lg" />
      <Skeleton className="h-9 w-full max-w-lg" />
    </div>
  )
}
