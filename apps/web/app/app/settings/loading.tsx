import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the settings shell: preserves the tab layout. */
export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading settings">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-5 w-56" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-24" />
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-32" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  )
}
