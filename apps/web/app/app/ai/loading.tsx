import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the assistant: preserves the sidebar + chat layout. */
export default function AiLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading the AI assistant">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="flex gap-4">
        <div className="hidden w-64 flex-col gap-2 md:flex">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
        <div className="flex flex-1 flex-col gap-3">
          <Skeleton className="h-16 w-2/3" />
          <Skeleton className="ml-auto h-16 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </div>
  )
}
