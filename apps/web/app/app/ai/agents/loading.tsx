import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the agents page: preserves the list + detail layout. */
export default function AiAgentsLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading AI agents">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
        <Skeleton className="h-72 w-full" />
      </div>
    </div>
  )
}
