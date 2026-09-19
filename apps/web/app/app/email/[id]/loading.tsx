import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the email thread detail page. */
export default function EmailThreadLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading email thread">
      <Skeleton className="h-8 w-80" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}
