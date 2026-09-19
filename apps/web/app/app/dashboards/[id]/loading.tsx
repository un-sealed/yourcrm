import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the dashboard detail page. */
export default function DashboardDetailLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading dashboard">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}
