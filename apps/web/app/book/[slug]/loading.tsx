import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the public booking page. */
export default function PublicBookingLoading() {
  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col gap-4 p-8" aria-busy="true">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}
