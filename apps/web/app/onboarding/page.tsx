"use client"

import Link from "next/link"
import { Button } from "@yourcrm/ui"
import { OnboardingChecklist } from "@/components/onboarding-checklist"

/**
 * First-run onboarding (spec 42-onboarding). Replaces the earlier
 * placeholder: every step below is computed server-side from real
 * workspace data (people/deals/pipelines/memberships/workspace settings),
 * never from a click here — see `OnboardingChecklist`.
 */
export default function OnboardingPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold">Welcome to YourCRM</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A few real actions get your workspace to first value. Each step below completes itself as
          soon as you&apos;ve actually done it — nothing to check off by hand.
        </p>
      </div>

      <OnboardingChecklist />

      <Link href="/app/dashboard">
        <Button variant="outline" className="w-full">
          Go to dashboard
        </Button>
      </Link>
    </div>
  )
}
