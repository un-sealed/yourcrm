import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the WhatsApp conversation list: preserves the layout. */
export default function WhatsAppLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading WhatsApp">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-9 w-36" />
      </div>
      <Skeleton className="h-9 w-full max-w-xs" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    </div>
  )
}
