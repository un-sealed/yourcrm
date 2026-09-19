"use client"

import type { ReactNode } from "react"
import Link from "next/link"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Badge, Button, Skeleton, cn, buttonVariants } from "@yourcrm/ui"
import { getHealth, type HealthResponse } from "@/lib/api-client"
import { OnboardingChecklist } from "@/components/onboarding-checklist"

/**
 * Workspace overview (spec 27 home).
 *
 * Presentation rules: a restrained enterprise layout — a single type scale,
 * one accent colour, hairline borders, tabular figures for numbers, and cards
 * as the only grouping primitive. Content is ordered most-important-first
 * (metrics, then actions, then workspace health) and never presents a number
 * it does not have: metrics that have no data source yet read as a clean
 * em dash with a plain caption rather than a fabricated figure.
 *
 * Live plumbing is unchanged: the `getHealth` query is the same call with the
 * same key. The setup-progress card reuses the existing, already-shipped
 * `OnboardingChecklist`, which sources its own real data from
 * `GET /api/v1/onboarding/progress`. No API contract is modified.
 */

type Metric = {
  label: string
  value: string
  caption: string
  icon: ReactNode
}

type IconProps = { children: ReactNode }

function Icon({ children }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-[18px] w-[18px]"
    >
      {children}
    </svg>
  )
}

const ICONS = {
  people: (
    <Icon>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Icon>
  ),
  deals: (
    <Icon>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
      <path d="M2 13h20" />
    </Icon>
  ),
  tasks: (
    <Icon>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </Icon>
  ),
  leads: (
    <Icon>
      <path d="M12 2v4" />
      <path d="M12 18v4" />
      <circle cx="12" cy="12" r="4" />
      <path d="M4.9 4.9l2.8 2.8" />
      <path d="M16.3 16.3l2.8 2.8" />
      <path d="M19.1 4.9l-2.8 2.8" />
      <path d="M7.7 16.3l-2.8 2.8" />
    </Icon>
  ),
  arrow: (
    <Icon>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </Icon>
  ),
}

const METRICS: Metric[] = [
  { label: "People", value: "—", caption: "No data source connected", icon: ICONS.people },
  { label: "Open deals", value: "—", caption: "No data source connected", icon: ICONS.deals },
  { label: "Tasks due", value: "—", caption: "No data source connected", icon: ICONS.tasks },
  { label: "New leads", value: "—", caption: "No data source connected", icon: ICONS.leads },
]

const QUICK_LINKS = [
  { href: "/app/people", label: "People", hint: "Contacts & companies", icon: ICONS.people },
  { href: "/app/deals", label: "Deals", hint: "Pipeline & stages", icon: ICONS.deals },
  { href: "/app/tasks", label: "Tasks", hint: "What is due next", icon: ICONS.tasks },
  { href: "/app/reports", label: "Reports", hint: "Insights & exports", icon: ICONS.leads },
]

function statusOf(health: ReturnType<typeof useQuery<HealthResponse>>) {
  if (health.isPending) return { tone: "secondary" as const, label: "Checking" }
  if (health.isError) return { tone: "destructive" as const, label: "Offline" }
  return health.data.status === "ok"
    ? { tone: "success" as const, label: "Operational" }
    : { tone: "warning" as const, label: "Degraded" }
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border border-border bg-card shadow-panel", className)}>
      {children}
    </section>
  )
}

function CardHeader({
  title,
  description,
  action,
  id,
}: {
  title: string
  description?: string
  action?: ReactNode
  id?: string
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div className="min-w-0">
        <h2 id={id} className="text-sm font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  )
}

export default function DashboardPage() {
  const health = useQuery({ queryKey: ["health"], queryFn: ({ signal }) => getHealth(signal) })
  const refresh = useMutation({ mutationFn: () => health.refetch() })
  const status = statusOf(health)

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
      {/* Page header */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Workspace overview
          </p>
          <h1 className="mt-0.5 text-xl font-semibold">Dashboard</h1>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={status.tone} aria-live="polite">
            {status.label}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
          >
            {refresh.isPending ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </header>

      {/* Metrics */}
      <section aria-label="Key metrics" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {METRICS.map((metric) => (
          <Card key={metric.label} className="p-5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {metric.label}
              </span>
              <span className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                {metric.icon}
              </span>
            </div>
            <p className="mt-3 text-3xl font-semibold tabular-nums tracking-tight">
              {metric.value}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{metric.caption}</p>
          </Card>
        ))}
      </section>

      {/* Actions + workspace health */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            id="quick-links-heading"
            title="Quick links"
            description="Jump straight into the areas you use most."
          />
          <div className="grid gap-px overflow-hidden rounded-b-xl bg-border sm:grid-cols-2">
            {QUICK_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="group flex items-center gap-3 bg-card p-4 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                  {link.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">{link.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{link.hint}</span>
                </span>
                <span className="text-muted-foreground transition-transform group-hover:translate-x-0.5">
                  {ICONS.arrow}
                </span>
              </Link>
            ))}
          </div>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader
              id="setup-heading"
              title="Setup progress"
              description="Tracked automatically from real workspace data."
            />
            <div className="p-5">
              <OnboardingChecklist compact />
            </div>
          </Card>
        </div>
      </div>

      {/* System status */}
      <Card>
        <CardHeader
          id="api-status-heading"
          title="API status"
          description="Live health of the services this workspace depends on."
          action={<Badge tone={status.tone}>{status.label}</Badge>}
        />
        <div className="p-5">
          {health.isPending ? (
            <div
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
              aria-busy="true"
              aria-label="Checking API status"
            >
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : health.isError ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-destructive">API unreachable</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Start it with <code className="font-mono">bun run dev</code> in{" "}
                  <code className="font-mono">apps/api</code>.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refresh.mutate()}
                disabled={refresh.isPending}
              >
                Try again
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {Object.entries(health.data.checks).map(([name, check]) => (
                  <div
                    key={name}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5"
                  >
                    <span className="text-sm capitalize text-muted-foreground">{name}</span>
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "h-2 w-2 rounded-full",
                          check.ok ? "bg-emerald-500" : "bg-destructive",
                        )}
                      />
                      <span
                        className={cn(
                          "text-xs font-medium",
                          check.ok ? "text-foreground" : "text-destructive",
                        )}
                      >
                        {check.ok ? "Operational" : "Down"}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
                <p className="text-xs text-muted-foreground">
                  Status <span className="font-medium text-foreground">{health.data.status}</span> ·
                  version {health.data.version}
                </p>
                <Link
                  href="/app/settings"
                  className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-xs")}
                >
                  Workspace settings
                </Link>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
