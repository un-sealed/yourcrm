import type { ServiceContext } from "../index"

/**
 * Overview service ports (mirrors the onboarding module pattern, see
 * `../onboarding/types.ts`). `@yourcrm/crm` has no database dependency, so
 * the service depends on this structural port instead; the API layer
 * adapts the drizzle repository (`overview-repository.ts`) to it.
 *
 * This module is READ-ONLY: there is no write path, so — unlike every
 * other module — there is no `AuditWriter` / `EventEmitter` dependency at
 * all. Every number the service returns is recomputed live from other
 * modules' tables (people/deals/activities/companies) inside
 * `store.getOverview()`; nothing here is cached or caller-suppliable, the
 * same "derive, never trust" rule onboarding applies to its checklist.
 */

export type OverviewTrendPoint = {
  date: string
  created: number
  won: number
}

export type OverviewActivityPoint = {
  date: string
  label: string
  count: number
}

export type OverviewRecentDeal = {
  id: string
  name: string
  company: string | null
  amount: number | null
  currency: string
  stage: string
  updatedAt: string
}

/**
 * Raw signals the repository computes and the service turns into the final
 * KPI shape. `current` / `prior` are counts (or, for `openPipelineValue`,
 * a money sum) over two equal-length, back-to-back windows — see
 * `overview-repository.ts` for the exact boundaries, which are kept
 * consistent with `trend` (30 days) and `activityByDay` (7 days) so the
 * KPI numbers and the charts never disagree.
 *
 * `openPipelineValue.priorValue` is always `null`: it is a point-in-time
 * snapshot of currently-open deals, and there is no historical
 * snapshot/audit table in this schema to reconstruct what that sum was at
 * a prior instant. Every other signal has a well-defined prior window
 * (even if the count in it is legitimately 0), so their deltas are never
 * `null`.
 */
export type OverviewSignals = {
  /** Workspace's configured currency; money sums are scoped to it (see repo). */
  workspaceCurrency: string
  openPipelineValue: { value: number; priorValue: number | null }
  dealsWonThisMonth: { current: number; prior: number }
  newContactsThisMonth: { current: number; prior: number }
  activitiesThisWeek: { current: number; prior: number }
  /** Sum of `amount` for deals won in the current 30-day window (goal numerator). */
  wonValueThisMonth: number
  /** Last 30 days, ascending, zero-filled. */
  trend: OverviewTrendPoint[]
  /** Last 7 days incl. today, ascending, zero-filled. */
  activityByDay: OverviewActivityPoint[]
  recentDeals: OverviewRecentDeal[]
}

export type OverviewStore = {
  getOverview(workspaceId: string, now: Date): Promise<OverviewSignals>
}

export type OverviewServiceContext = ServiceContext

export type OverviewServiceDeps = {
  store: OverviewStore
  /** Injectable clock so period boundaries are deterministic in tests; defaults to `() => new Date()`. */
  now?: () => Date
}
