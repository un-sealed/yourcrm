import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the CS account list: preserves the table layout. */
export default function CustomerSuccessLoading() {
  return (
    <div
      className="flex flex-col gap-4"
      aria-busy="true"
      aria-label="Loading customer success accounts"
    >
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-9 w-32" />
      </div>
      <Skeleton className="h-9 w-full max-w-xs" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  )
}
