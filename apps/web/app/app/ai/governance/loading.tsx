import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the approval queue: preserves the list + diff layout. */
export default function AiGovernanceLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading AI approvals">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-9 w-48" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  )
}
