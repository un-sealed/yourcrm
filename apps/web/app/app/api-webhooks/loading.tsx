import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the API & webhooks page: preserves the layout. */
export default function ApiWebhooksLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading API and webhooks">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-9 w-28" />
      </div>
      <Skeleton className="h-4 w-full max-w-xl" />
      <div className="flex gap-2">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-24 w-full" />
        ))}
      </div>
    </div>
  )
}
