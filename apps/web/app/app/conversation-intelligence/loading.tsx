import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton: preserves the list + detail layout so nothing jumps. */
export default function ConversationIntelligenceLoading() {
  return (
    <div
      className="flex flex-col gap-4"
      aria-busy="true"
      aria-label="Loading conversation intelligence"
    >
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-9 w-40" />
      </div>
      <div className="flex flex-col gap-4 md:flex-row">
        <div className="flex w-full flex-col gap-2 md:w-80">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
        <div className="flex flex-1 flex-col gap-3">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </div>
  )
}
