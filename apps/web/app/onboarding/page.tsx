import Link from "next/link"
import { Button } from "@yourcrm/ui"

/** First-run experience skeleton (steps land with spec 42-onboarding). */
export default function OnboardingPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-8">
      <h1 className="text-2xl font-semibold">Welcome to YourCRM</h1>
      <ol className="mt-6 flex flex-col gap-3 text-sm">
        {[
          "Name your workspace",
          "Pick timezone + currency",
          "Load sample data",
          "Invite your team",
          "See your dashboard",
        ].map((step, i) => (
          <li key={step} className="rounded-md border p-3">
            <span className="font-medium">
              {i + 1}. {step}
            </span>
          </li>
        ))}
      </ol>
      <Link href="/app/dashboard" className="mt-6">
        <Button className="w-full">Skip for now → dashboard</Button>
      </Link>
    </div>
  )
}
