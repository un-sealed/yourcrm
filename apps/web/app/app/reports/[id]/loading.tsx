import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for a report page: header, definition, result table. */
export default function ReportLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading report">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}
