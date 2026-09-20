import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import type { Database } from "../client"
import { activities } from "../schema/activities"
import { companies } from "../schema/companies"
import { workspaces } from "../schema/core"
import { deals, OPEN_DEAL_STAGES } from "../schema/deals"
import { people } from "../schema/people"

/**
 * Overview repository: read-only aggregate SQL feeding the home dashboard
 * (`GET /api/v1/overview`, see `@yourcrm/crm/src/overview`). Every query
 * filters by `workspace_id` and excludes soft-deleted rows, matching the
 * shared `base-repository.ts` convention (there is no write path here, so
 * it does not wrap `createBaseRepository`).
 *
 * Query strategy: several small, independently-readable queries rather
 * than one `FILTER (WHERE ...)` mega-query. This is a dashboard read, not
 * a hot path — the same tradeoff `onboarding-repository.ts` makes.
 */

const TREND_WINDOW_DAYS = 30
const ACTIVITY_WINDOW_DAYS = 7
const RECENT_DEALS_LIMIT = 5

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

export type OverviewTrendPoint = { date: string; created: number; won: number }
export type OverviewActivityPoint = { date: string; label: string; count: number }
export type OverviewRecentDeal = {
  id: string
  name: string
  company: string | null
  amount: number | null
  currency: string
  stage: string
  updatedAt: string
}

export type OverviewSignals = {
  workspaceCurrency: string
  openPipelineValue: { value: number; priorValue: number | null }
  dealsWonThisMonth: { current: number; prior: number }
  newContactsThisMonth: { current: number; prior: number }
  activitiesThisWeek: { current: number; prior: number }
  wonValueThisMonth: number
  trend: OverviewTrendPoint[]
  activityByDay: OverviewActivityPoint[]
  recentDeals: OverviewRecentDeal[]
}

/**
 * `amount` is NUMERIC(14,2). postgres.js (and drizzle, which defers to it)
 * returns NUMERIC as a decimal string over the wire on purpose, so a large
 * amount is never silently rounded through a JS double inside the driver.
 * We deliberately convert to `number` only here, at the read boundary, for
 * display — nothing in this module does further arithmetic that would
 * compound float error, so the precision `number` offers is sufficient.
 * `coalesce(sum(...), 0)` in SQL means an empty group reads as `"0"`, not
 * `null`.
 */
function parseMoney(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function parseNullableMoney(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000)
}

function dayKey(d: Date): string {
  // `d` is always a UTC-midnight Date here, so the ISO date prefix is the
  // calendar day regardless of the host's local timezone.
  return d.toISOString().slice(0, 10)
}

/** Inclusive list of UTC day keys from `start` to `end` (both day-truncated). */
function dayKeysBetween(start: Date, end: Date): string[] {
  const keys: string[] = []
  for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) {
    keys.push(dayKey(d))
  }
  return keys
}

type DayCountRow = { day: string | null; count: number | string | null }

function toDayCountMap(rows: DayCountRow[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const row of rows) {
    if (!row.day) continue
    map.set(row.day, Number(row.count ?? 0))
  }
  return map
}

/** `date_trunc` in UTC, formatted `YYYY-MM-DD`, so buckets match `dayKey()`. */
function dayBucketExpr(column: PgColumn) {
  return sql<string>`to_char(date_trunc('day', ${column} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`
}

export function createOverviewRepository() {
  async function getWorkspaceCurrency(db: Database, workspaceId: string): Promise<string> {
    const rows = await db
      .select({ currency: workspaces.currency })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
      .limit(1)
    return rows[0]?.currency ?? "USD"
  }

  async function getOpenPipelineValue(
    db: Database,
    workspaceId: string,
    currency: string,
  ): Promise<number> {
    const rows = await db
      .select({ total: sql<string>`coalesce(sum(${deals.amount}), 0)::text` })
      .from(deals)
      .where(
        and(
          eq(deals.workspaceId, workspaceId),
          isNull(deals.deletedAt),
          inArray(deals.stage, [...OPEN_DEAL_STAGES]),
          eq(deals.currency, currency),
        ),
      )
    return parseMoney(rows[0]?.total)
  }

  /** Count of deals that transitioned to `won` in `[start, end)`. */
  async function countWonDeals(
    db: Database,
    workspaceId: string,
    start: Date,
    end: Date,
  ): Promise<number> {
    const rows = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(deals)
      .where(
        and(
          eq(deals.workspaceId, workspaceId),
          isNull(deals.deletedAt),
          eq(deals.stage, "won"),
          gte(deals.updatedAt, start),
          lt(deals.updatedAt, end),
        ),
      )
    return Number(rows[0]?.value ?? 0)
  }

  /**
   * Sum of `amount` for deals won in `[start, end)`, scoped to `currency`.
   * Deals do not carry a dedicated "won at" timestamp (spec 09-deals), so
   * `updated_at` is used as the closest real signal — the `close()` write
   * path (`deals-repository.ts`) always bumps `updated_at` on a stage
   * change to `won`. This is an approximation: a won deal edited later for
   * an unrelated reason (e.g. a note fix) would also bump `updated_at`,
   * nudging it into a different window. See the module report for why a
   * true `wonAt` column is out of scope here.
   */
  async function sumWonValue(
    db: Database,
    workspaceId: string,
    currency: string,
    start: Date,
    end: Date,
  ): Promise<number> {
    const rows = await db
      .select({ total: sql<string>`coalesce(sum(${deals.amount}), 0)::text` })
      .from(deals)
      .where(
        and(
          eq(deals.workspaceId, workspaceId),
          isNull(deals.deletedAt),
          eq(deals.stage, "won"),
          eq(deals.currency, currency),
          gte(deals.updatedAt, start),
          lt(deals.updatedAt, end),
        ),
      )
    return parseMoney(rows[0]?.total)
  }

  async function countPeople(
    db: Database,
    workspaceId: string,
    start: Date,
    end: Date,
  ): Promise<number> {
    const rows = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(people)
      .where(
        and(
          eq(people.workspaceId, workspaceId),
          isNull(people.deletedAt),
          gte(people.createdAt, start),
          lt(people.createdAt, end),
        ),
      )
    return Number(rows[0]?.value ?? 0)
  }

  async function countActivities(
    db: Database,
    workspaceId: string,
    start: Date,
    end: Date,
  ): Promise<number> {
    const rows = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(activities)
      .where(
        and(
          eq(activities.workspaceId, workspaceId),
          isNull(activities.deletedAt),
          gte(activities.createdAt, start),
          lt(activities.createdAt, end),
        ),
      )
    return Number(rows[0]?.value ?? 0)
  }

  async function dealsCreatedByDay(
    db: Database,
    workspaceId: string,
    start: Date,
    end: Date,
  ): Promise<Map<string, number>> {
    const rows = await db
      .select({
        day: dayBucketExpr(deals.createdAt),
        count: sql<number>`count(*)::int`,
      })
      .from(deals)
      .where(
        and(
          eq(deals.workspaceId, workspaceId),
          isNull(deals.deletedAt),
          gte(deals.createdAt, start),
          lt(deals.createdAt, end),
        ),
      )
      .groupBy(dayBucketExpr(deals.createdAt))
    return toDayCountMap(rows)
  }

  /** Same `updated_at`-as-proxy approximation as `sumWonValue()` above. */
  async function dealsWonByDay(
    db: Database,
    workspaceId: string,
    start: Date,
    end: Date,
  ): Promise<Map<string, number>> {
    const rows = await db
      .select({
        day: dayBucketExpr(deals.updatedAt),
        count: sql<number>`count(*)::int`,
      })
      .from(deals)
      .where(
        and(
          eq(deals.workspaceId, workspaceId),
          isNull(deals.deletedAt),
          eq(deals.stage, "won"),
          gte(deals.updatedAt, start),
          lt(deals.updatedAt, end),
        ),
      )
      .groupBy(dayBucketExpr(deals.updatedAt))
    return toDayCountMap(rows)
  }

  async function activitiesByDay(
    db: Database,
    workspaceId: string,
    start: Date,
    end: Date,
  ): Promise<Map<string, number>> {
    const rows = await db
      .select({
        day: dayBucketExpr(activities.createdAt),
        count: sql<number>`count(*)::int`,
      })
      .from(activities)
      .where(
        and(
          eq(activities.workspaceId, workspaceId),
          isNull(activities.deletedAt),
          gte(activities.createdAt, start),
          lt(activities.createdAt, end),
        ),
      )
      .groupBy(dayBucketExpr(activities.createdAt))
    return toDayCountMap(rows)
  }

  async function recentDeals(db: Database, workspaceId: string): Promise<OverviewRecentDeal[]> {
    const rows = await db
      .select({
        id: deals.id,
        name: deals.name,
        company: companies.name,
        amount: deals.amount,
        currency: deals.currency,
        stage: deals.stage,
        updatedAt: deals.updatedAt,
      })
      .from(deals)
      .leftJoin(companies, and(eq(companies.id, deals.companyId), isNull(companies.deletedAt)))
      .where(and(eq(deals.workspaceId, workspaceId), isNull(deals.deletedAt)))
      .orderBy(desc(deals.updatedAt))
      .limit(RECENT_DEALS_LIMIT)
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      company: row.company ?? null,
      amount: parseNullableMoney(row.amount),
      currency: row.currency,
      stage: row.stage,
      updatedAt: row.updatedAt.toISOString(),
    }))
  }

  return {
    async getOverview(db: Database, workspaceId: string, now: Date): Promise<OverviewSignals> {
      const today = startOfUtcDay(now)
      const trendStart = addDays(today, -(TREND_WINDOW_DAYS - 1))
      const priorTrendStart = addDays(trendStart, -TREND_WINDOW_DAYS)
      const weekStart = addDays(today, -(ACTIVITY_WINDOW_DAYS - 1))
      const priorWeekStart = addDays(weekStart, -ACTIVITY_WINDOW_DAYS)

      // Sequential, not Promise.all: this runs once per dashboard load, not
      // a hot path, and sequential awaits keep query order simple to read
      // and to test against a stubbed db (see overview-repository.test.ts).
      const workspaceCurrency = await getWorkspaceCurrency(db, workspaceId)
      const openPipelineValue = await getOpenPipelineValue(db, workspaceId, workspaceCurrency)
      const wonThisMonthPrior = await countWonDeals(db, workspaceId, priorTrendStart, trendStart)
      const wonValueThisMonth = await sumWonValue(
        db,
        workspaceId,
        workspaceCurrency,
        trendStart,
        now,
      )
      const newContactsCurrent = await countPeople(db, workspaceId, trendStart, now)
      const newContactsPrior = await countPeople(db, workspaceId, priorTrendStart, trendStart)
      const activitiesWeekPrior = await countActivities(db, workspaceId, priorWeekStart, weekStart)
      const createdByDay = await dealsCreatedByDay(db, workspaceId, trendStart, now)
      const wonByDay = await dealsWonByDay(db, workspaceId, trendStart, now)
      const activityByDayMap = await activitiesByDay(db, workspaceId, weekStart, now)
      const recent = await recentDeals(db, workspaceId)

      const trendDays = dayKeysBetween(trendStart, today)
      const trend: OverviewTrendPoint[] = trendDays.map((date) => ({
        date,
        created: createdByDay.get(date) ?? 0,
        won: wonByDay.get(date) ?? 0,
      }))
      // KPI count derived from the same grouped data as the chart, so the
      // two can never disagree.
      const dealsWonThisMonthCurrent = trend.reduce((sum, point) => sum + point.won, 0)

      const activityDays = dayKeysBetween(weekStart, today)
      const activityByDay: OverviewActivityPoint[] = activityDays.map((date) => ({
        date,
        label: WEEKDAY_LABELS[new Date(`${date}T00:00:00.000Z`).getUTCDay()] ?? "",
        count: activityByDayMap.get(date) ?? 0,
      }))
      const activitiesThisWeekCurrent = activityByDay.reduce((sum, point) => sum + point.count, 0)

      return {
        workspaceCurrency,
        // No historical snapshot/audit-of-amounts table exists to derive a
        // prior-period open pipeline value, so this is always null (see
        // `OverviewSignals` doc comment and the module report).
        openPipelineValue: { value: openPipelineValue, priorValue: null },
        dealsWonThisMonth: { current: dealsWonThisMonthCurrent, prior: wonThisMonthPrior },
        newContactsThisMonth: { current: newContactsCurrent, prior: newContactsPrior },
        activitiesThisWeek: { current: activitiesThisWeekCurrent, prior: activitiesWeekPrior },
        wonValueThisMonth,
        trend,
        activityByDay,
        recentDeals: recent,
      }
    },
  }
}

export type OverviewRepository = ReturnType<typeof createOverviewRepository>
