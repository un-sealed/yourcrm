"use client"

import { useQuery } from "@tanstack/react-query"
import { getHealth } from "@/lib/api-client"

/** First real page: proves TanStack Query <-> API wiring. */
export default function DashboardPage() {
  const health = useQuery({ queryKey: ["health"], queryFn: ({ signal }) => getHealth(signal) })

  return (
    <div>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Pipeline metrics and briefings land in later phases.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {[
          { label: "Open deals", value: "—" },
          { label: "Tasks due", value: "—" },
          { label: "New leads (7d)", value: "—" },
        ].map((card) => (
          <div key={card.label} className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            <p className="mt-1 text-2xl font-semibold">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-lg border p-4 text-sm">
        <p className="font-medium">API status</p>
        {health.isPending && <p className="text-muted-foreground">Loading…</p>}
        {health.isError && <p className="text-destructive">API unreachable (start apps/api).</p>}
        {health.data && (
          <p>
            API {health.data.status} · v{health.data.version}
          </p>
        )}
      </div>
    </div>
  )
}
