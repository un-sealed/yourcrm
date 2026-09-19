import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the calendar month view: preserves the grid layout. */
export default function CalendarLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading calendar">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-9 w-40" />
      </div>
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-96 w-full" />
    </div>
  )
}
