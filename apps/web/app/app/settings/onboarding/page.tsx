"use client"

import { OnboardingChecklist } from "@/components/onboarding-checklist"

/** Onboarding checklist surfaced inside the app (spec 42-onboarding). */
export default function SettingsOnboardingPage() {
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Onboarding checklist</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tracks real progress toward first value. Steps complete themselves as your workspace gets
          real data — nothing here can be checked off by hand.
        </p>
      </div>
      <OnboardingChecklist />
    </div>
  )
}
