"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { Button } from "@yourcrm/ui"
import { getHealth } from "@/lib/api-client"

/** Marketing/root page with live API connectivity status. */
export default function HomePage() {
  const health = useQuery({ queryKey: ["health"], queryFn: ({ signal }) => getHealth(signal) })

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center p-8 text-center">
      <h1 className="text-4xl font-bold">YourCRM</h1>
      <p className="mt-2 text-muted-foreground">AI-native, self-hostable open-source CRM.</p>

      <div className="mt-6 flex gap-2">
        <Link href="/login">
          <Button>Log in</Button>
        </Link>
        <Link href="/signup">
          <Button variant="outline">Sign up</Button>
        </Link>
        <Link href="/app/dashboard">
          <Button variant="secondary">Open app</Button>
        </Link>
      </div>

      <div className="mt-8 w-full rounded-lg border p-4 text-left text-sm" data-testid="api-status">
        <p className="font-medium">API connectivity</p>
        {health.isPending && (
          <p className="text-muted-foreground">
            Checking {process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/health…
          </p>
        )}
        {health.isError && (
          <p className="text-destructive">
            API unreachable. Start it with `bun run dev` in apps/api.
          </p>
        )}
        {health.data && (
          <p>
            Status: <strong>{health.data.status}</strong> (v{health.data.version}) —{" "}
            {Object.entries(health.data.checks)
              .map(([k, v]) => `${k}:${v.ok ? "ok" : "down"}`)
              .join(" · ")}
          </p>
        )}
      </div>
    </div>
  )
}
