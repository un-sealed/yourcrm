import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the notification center: preserves the list layout. */
export default function NotificationsLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading notifications">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    </div>
  )
}
