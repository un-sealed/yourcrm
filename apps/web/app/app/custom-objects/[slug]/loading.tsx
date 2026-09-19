import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for a custom object page: header, tabs and rows. */
export default function CustomObjectLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading custom object">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-9 w-56" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  )
}
