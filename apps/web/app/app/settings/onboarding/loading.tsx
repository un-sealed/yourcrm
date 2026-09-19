import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the in-app onboarding checklist: preserves layout. */
export default function SettingsOnboardingLoading() {
  return (
    <div
      className="flex max-w-2xl flex-col gap-4"
      aria-busy="true"
      aria-label="Loading onboarding checklist"
    >
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    </div>
  )
}
