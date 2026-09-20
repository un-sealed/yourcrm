"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import {
  AreaChart,
  BarChart,
  DataTable,
  RadialGauge,
  Skeleton,
  StatTile,
  buttonVariants,
  cn,
  type DataTableColumn,
} from "@yourcrm/ui"
import { getOverview, type OverviewResponse } from "@/lib/api-client"
import { OnboardingChecklist } from "@/components/onboarding-checklist"

/**
 * Workspace overview (spec 27 home), rebuilt against
 * `docs/design/DASHBOARD-REDESIGN.md`.
 *
 * The old "midnight glass" surface is gone along with the tokens it relied
 * on (aurora background, `text-gradient`, `shadow-glow`). Everything here
 * reads the light token set from `globals.css` — no ad-hoc hex, no gradient
 * invented per component.
 *
 * Every number on this page comes from `GET /api/v1/overview`, one request
 * shared by the tiles, both charts, the gauge and the table, so no two
 * panels can disagree. Where the API cannot source a figure it sends
 * `null`, and this page renders the absence (no delta chip) rather than
 * substituting a zero.
 */

type RecentDeal = OverviewResponse["recentDeals"][number]

function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value)
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value)
}

/**
 * A delta is a ratio from the API. It becomes a tile chip only when the API
 * actually had a prior period to compare with; `null` means "unknown", which
 * is not the same as "unchanged".
 */
function deltaChip(delta: number | null) {
  if (delta === null) return undefined
  const pct = Math.round(Math.abs(delta) * 100)
  return {
    value: `${pct}%`,
    direction: delta >= 0 ? ("up" as const) : ("down" as const),
  }
}

const ICON = {
  pipeline: (
    <path d="M3 6h18M6 12h12M10 18h4" />
  ),
  won: <path d="M20 6 9 17l-5-5" />,
  contacts: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 11.2a3 3 0 0 0 0-5.9M18.5 19a5.2 5.2 0 0 0-2.4-4.3" />
    </>
  ),
  activity: <path d="M3 12h4l3 7 4-14 3 7h4" />,
}

function Icon({ children }: { children: React.ReactNode }) {
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

function Panel({
  title,
  action,
  children,
  className,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        "rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface-1)]",
        "p-5 shadow-[var(--shadow-card)]",
        className,
      )}
    >
      <header className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  )
}

const DEAL_COLUMNS: DataTableColumn<RecentDeal>[] = [
  {
    id: "name",
    header: "Deal",
    accessor: (row) => <span className="font-medium text-[var(--text-primary)]">{row.name}</span>,
  },
  {
    id: "company",
    header: "Company",
    // An unlinked deal is genuinely companyless; an em dash says so.
    accessor: (row) => row.company ?? <span className="text-[var(--text-muted)]">—</span>,
  },
  {
    id: "stage",
    header: "Stage",
    accessor: (row) => (
      <span className="rounded-[var(--radius-pill)] bg-[var(--surface-2)] px-2.5 py-1 text-xs capitalize text-[var(--text-secondary)]">
        {row.stage.replace(/_/g, " ")}
      </span>
    ),
  },
  {
    id: "amount",
    header: "Amount",
    align: "right",
    accessor: (row) =>
      row.amount === null ? (
        <span className="text-[var(--text-muted)]">—</span>
      ) : (
        formatMoney(row.amount, row.currency)
      ),
  },
]

function LoadingState() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[104px] rounded-[var(--radius-card)]" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-[320px] rounded-[var(--radius-card)] lg:col-span-2" />
        <Skeleton className="h-[320px] rounded-[var(--radius-card)]" />
      </div>
      <Skeleton className="h-[280px] rounded-[var(--radius-card)]" />
    </div>
  )
}

export default function DashboardPage() {
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: ({ signal }) => getOverview(signal),
  })

  const data = overview.data

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
            Overview
          </h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Your pipeline and activity across the last 30 days.
          </p>
        </div>
        <Link href="/app/deals" className={cn(buttonVariants({ size: "sm" }))}>
          View pipeline
        </Link>
      </div>

      {overview.isPending ? <LoadingState /> : null}

      {overview.isError ? (
        <div
          role="alert"
          className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface-1)] p-5"
        >
          <p className="text-sm font-medium text-[var(--text-primary)]">
            Could not load your overview.
          </p>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            {overview.error instanceof Error ? overview.error.message : "Unexpected error."}
          </p>
          <button
            type="button"
            onClick={() => void overview.refetch()}
            className={cn(buttonVariants({ size: "sm", variant: "outline" }), "mt-3")}
          >
            Try again
          </button>
        </div>
      ) : null}

      {data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="Open pipeline"
              value={formatMoney(
                data.kpis.openPipelineValue.value,
                data.kpis.openPipelineValue.currency ?? "USD",
              )}
              delta={deltaChip(data.kpis.openPipelineValue.delta)}
              caption="Value of deals still open"
              icon={<Icon>{ICON.pipeline}</Icon>}
            />
            <StatTile
              label="Deals won"
              value={formatCount(data.kpis.dealsWonThisMonth.value)}
              delta={deltaChip(data.kpis.dealsWonThisMonth.delta)}
              caption="Last 30 days"
              icon={<Icon>{ICON.won}</Icon>}
            />
            <StatTile
              label="New contacts"
              value={formatCount(data.kpis.newContactsThisMonth.value)}
              delta={deltaChip(data.kpis.newContactsThisMonth.delta)}
              caption="Last 30 days"
              icon={<Icon>{ICON.contacts}</Icon>}
            />
            <StatTile
              label="Activities"
              value={formatCount(data.kpis.activitiesThisWeek.value)}
              delta={deltaChip(data.kpis.activitiesThisWeek.delta)}
              caption="Last 7 days"
              icon={<Icon>{ICON.activity}</Icon>}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title="Deals created vs won" className="lg:col-span-2">
              <AreaChart
                data={data.trend.map((point) => ({
                  label: point.date,
                  value: point.created,
                  compare: point.won,
                }))}
                series="Created"
                compareSeries="Won"
                formatValue={formatCount}
              />
            </Panel>

            <Panel title="Goal attainment">
              {/*
                The gauge reads as a percentage, not as a raw currency figure:
                the ring encodes a fraction, so the headline should too. The
                money it is a fraction *of* goes in the caption underneath.
              */}
              <RadialGauge
                value={data.goal.attained * 100}
                max={100}
                formatValue={(v) => `${Math.round(v)}%`}
                label="Won this period"
                caption={`${formatMoney(
                  data.goal.wonValue,
                  data.kpis.openPipelineValue.currency ?? "USD",
                )} of ${formatMoney(
                  data.goal.targetValue,
                  data.kpis.openPipelineValue.currency ?? "USD",
                )}`}
              />
            </Panel>
          </div>

          {/*
            `items-start` matters here: the onboarding checklist is far taller
            than the bar chart, and a stretched grid row left the chart panel
            with a tall band of empty surface under it.
          */}
          <div className="grid items-start gap-4 lg:grid-cols-3">
            <Panel title="Activity by day" className="lg:col-span-2">
              <BarChart
                data={data.activityByDay.map((point) => ({
                  label: point.label,
                  value: point.count,
                }))}
                // Today is the last bucket; the spec highlights it.
                highlightIndex={data.activityByDay.length - 1}
                formatValue={formatCount}
              />
            </Panel>

            <Panel title="Set up your workspace">
              <OnboardingChecklist />
            </Panel>
          </div>

          <Panel
            title="Recent deals"
            action={
              <Link
                href="/app/deals"
                className="text-sm font-medium text-[var(--brand)] hover:underline"
              >
                View all
              </Link>
            }
          >
            {data.recentDeals.length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--text-secondary)]">
                No deals yet. Create one to see it here.
              </p>
            ) : (
              <DataTable
                rows={data.recentDeals}
                columns={DEAL_COLUMNS}
                getRowId={(row) => row.id}
              />
            )}
          </Panel>
        </>
      ) : null}
    </div>
  )
}
