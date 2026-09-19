import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for notification preferences: preserves the form layout. */
export default function NotificationPreferencesLoading() {
  return (
    <div
      className="flex max-w-2xl flex-col gap-6"
      aria-busy="true"
      aria-label="Loading notification preferences"
    >
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  )
}
