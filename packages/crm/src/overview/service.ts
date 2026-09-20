import { requirePermission } from "@yourcrm/permissions"
import type {
  OverviewActivityPoint,
  OverviewRecentDeal,
  OverviewServiceContext,
  OverviewServiceDeps,
  OverviewSignals,
  OverviewTrendPoint,
} from "./types"

function permissionOf(ctx: OverviewServiceContext, object: string) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object,
    action: "read" as const,
  }
}

export type OverviewKpi = { value: number; delta: number | null; currency?: string }

export type OverviewResult = {
  kpis: {
    openPipelineValue: OverviewKpi
    dealsWonThisMonth: OverviewKpi
    newContactsThisMonth: OverviewKpi
    activitiesThisWeek: OverviewKpi
  }
  trend: OverviewTrendPoint[]
  activityByDay: OverviewActivityPoint[]
  goal: { attained: number; wonValue: number; targetValue: number }
  recentDeals: OverviewRecentDeal[]
}

/**
 * Round to cents. Signals arrive already converted from NUMERIC(14,2)
 * strings to numbers by the repository (see its money-conversion comment);
 * summing several such numbers in JS can reintroduce float noise past the
 * 2nd decimal, so every money value that reaches the response is rounded
 * once, here, at the edge.
 */
function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

function countDelta(period: { current: number; prior: number }): number {
  return period.current - period.prior
}

/**
 * Overview domain service, feeding the redesigned home dashboard (P0).
 *
 * Single read-only entry point: `getOverview`. Every number is recomputed
 * live from `store.getOverview()` (people/deals/activities/companies) —
 * there is nothing here for a caller to assert, mirroring onboarding's
 * "derive, never trust" rule. Unlike every other module this one never
 * writes, so it has no audit/events dependency at all.
 */
export function createOverviewService(deps: OverviewServiceDeps) {
  const now = deps.now ?? (() => new Date())

  async function getOverview(ctx: OverviewServiceContext): Promise<OverviewResult> {
    requirePermission(permissionOf(ctx, "overview"))
    // Respect the caller's permissions for each underlying object this
    // aggregates, rather than bypassing requirePermission() to read
    // straight through to the repository.
    requirePermission(permissionOf(ctx, "deal"))
    requirePermission(permissionOf(ctx, "person"))
    requirePermission(permissionOf(ctx, "activity"))
    requirePermission(permissionOf(ctx, "company"))

    const signals: OverviewSignals = await deps.store.getOverview(ctx.workspaceId, now())

    const openValue = roundMoney(signals.openPipelineValue.value)
    const wonValue = roundMoney(signals.wonValueThisMonth)
    // Goal target = still-open pipeline value + what has already been won
    // this month — "the sum of open + won this month" from the spec.
    const targetValue = roundMoney(openValue + wonValue)
    const attained = targetValue > 0 ? Math.min(1, Math.max(0, wonValue / targetValue)) : 0

    return {
      kpis: {
        openPipelineValue: {
          value: openValue,
          delta:
            signals.openPipelineValue.priorValue === null
              ? null
              : roundMoney(openValue - signals.openPipelineValue.priorValue),
          currency: signals.workspaceCurrency,
        },
        dealsWonThisMonth: {
          value: signals.dealsWonThisMonth.current,
          delta: countDelta(signals.dealsWonThisMonth),
        },
        newContactsThisMonth: {
          value: signals.newContactsThisMonth.current,
          delta: countDelta(signals.newContactsThisMonth),
        },
        activitiesThisWeek: {
          value: signals.activitiesThisWeek.current,
          delta: countDelta(signals.activitiesThisWeek),
        },
      },
      trend: signals.trend,
      activityByDay: signals.activityByDay,
      goal: { attained, wonValue, targetValue },
      recentDeals: signals.recentDeals,
    }
  }

  return { getOverview }
}

export type OverviewService = ReturnType<typeof createOverviewService>
