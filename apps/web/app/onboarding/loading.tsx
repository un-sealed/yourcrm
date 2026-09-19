import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for the first-run onboarding page. */
export default function OnboardingLoading() {
  return (
    <div
      className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 p-8"
      aria-busy="true"
      aria-label="Loading onboarding"
    >
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    </div>
  )
}
