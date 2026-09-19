import { and, count, desc, eq, gte, inArray, isNull, lte, max, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import { activities } from "../schema/activities"
import {
  csAccounts,
  csHealthScores,
  csPlaybookTasks,
  csRenewals,
  isCsLifecycleStage,
  isCsRenewalStatus,
  type CsAccount,
  type CsHealthScore,
  type CsPlaybookTask,
  type CsRenewal,
  type NewCsAccount,
  type NewCsRenewal,
} from "../schema/customer-success"
import { deals, OPEN_DEAL_STAGES } from "../schema/deals"
import { createBaseRepository } from "./base-repository"

/**
 * Customer Success repository (spec 46-customer-success, P0).
 *
 * Mirrors two things from `reports-repository.ts`, the assigned reference
 * for cross-module aggregation:
 *
 *  1. Health scoring reads other modules' tables (`activities`, `deals`)
 *     READ-ONLY through a fixed factor registry (`computeCsHealthFactors`).
 *     `workspaceId` / `companyId` are always bound query parameters —
 *     never string-interpolated — and the set of factors is a hardcoded
 *     allowlist, not something a caller can shape.
 *  2. Row visibility (`CsAccountRowScope`) is derived by the domain service
 *     from the caller's permissions and threaded through every query that
 *     can return more than one caller's accounts, exactly like
 *     `ReportRowScope`. The repository never guesses it.
 *
 * Playbooks (`CS_PLAYBOOK_TASKS`) are a second allowlist: `playbook_key` is
 * validated against `CS_PLAYBOOKS` before anything is written, and this
 * module never inserts into `tasks` directly — task rows are created
 * through the tasks module's own service (`TasksPort` in
 * `@yourcrm/crm/src/customer-success`), so there is exactly one task
 * engine in the product.
 */

/* ------------------------------ playbooks ------------------------------ */

export type CsPlaybookTaskTemplate = {
  title: string
  description?: string
  dueOffsetDays: number
  priority: "low" | "medium" | "high" | "urgent"
}

export type CsPlaybookDef = {
  key: string
  label: string
  description: string
  tasks: readonly CsPlaybookTaskTemplate[]
}

/**
 * The entire set of playbooks a CS account can run. Adding one here is the
 * ONLY way to make it applicable — `applyCsPlaybook` (service layer)
 * rejects any other key before it reaches a task write.
 */
export const CS_PLAYBOOKS: Record<string, CsPlaybookDef> = {
  onboarding: {
    key: "onboarding",
    label: "Onboarding",
    description: "First-30-days plan for a newly won account.",
    tasks: [
      { title: "Kickoff call", dueOffsetDays: 3, priority: "high" },
      { title: "Send welcome resources", dueOffsetDays: 1, priority: "medium" },
      { title: "30-day check-in", dueOffsetDays: 30, priority: "medium" },
    ],
  },
  at_risk_outreach: {
    key: "at_risk_outreach",
    label: "At-risk outreach",
    description: "Re-engagement plan when health drops or activity goes quiet.",
    tasks: [
      { title: "Executive check-in call", dueOffsetDays: 2, priority: "urgent" },
      { title: "Review recent contact history", dueOffsetDays: 1, priority: "high" },
      { title: "Share a success plan", dueOffsetDays: 5, priority: "medium" },
    ],
  },
  renewal_save: {
    key: "renewal_save",
    label: "Renewal save",
    description: "Structured push toward a positive renewal outcome.",
    tasks: [
      { title: "Confirm renewal stakeholders", dueOffsetDays: 3, priority: "high" },
      { title: "Send renewal proposal", dueOffsetDays: 10, priority: "high" },
      { title: "Renewal decision follow-up", dueOffsetDays: 20, priority: "urgent" },
    ],
  },
}

export const CS_PLAYBOOK_KEYS = Object.keys(CS_PLAYBOOKS)

export function isCsPlaybookKey(value: unknown): value is string {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CS_PLAYBOOKS, value)
}

export class CsPlaybookError extends Error {
  readonly code = "INVALID_PLAYBOOK"
  constructor(message: string) {
    super(message)
    this.name = "CsPlaybookError"
  }
}

/** Allowlist lookup; `null` for an unknown key (never throws). */
export function findCsPlaybook(playbookKey: unknown): CsPlaybookDef | null {
  if (!isCsPlaybookKey(playbookKey)) return null
  return CS_PLAYBOOKS[playbookKey] ?? null
}

/** Allowlist gate for a playbook key. Unknown keys never reach a task write. */
export function resolveCsPlaybook(playbookKey: unknown): CsPlaybookDef {
  if (!isCsPlaybookKey(playbookKey)) {
    throw new CsPlaybookError(
      `customer-success: unknown playbook '${String(playbookKey)}' (allowed: ${CS_PLAYBOOK_KEYS.join(", ")})`,
    )
  }
  const def = CS_PLAYBOOKS[playbookKey]
  if (!def) throw new CsPlaybookError(`customer-success: unknown playbook '${playbookKey}'`)
  return def
}

/** Serialisable catalogue for the web playbook picker. */
export function describeCsPlaybooks(): {
  key: string
  label: string
  description: string
  taskCount: number
}[] {
  return CS_PLAYBOOK_KEYS.map((key) => {
    const def = CS_PLAYBOOKS[key] as CsPlaybookDef
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      taskCount: def.tasks.length,
    }
  })
}

/* ------------------------------ row scope ------------------------------ */

/**
 * Account visibility for one query, derived by the domain service from the
 * caller's permissions (`resolveAccountRowScope` in
 * `@yourcrm/crm/src/customer-success/access.ts`) and never accepted from
 * request input.
 *
 * - `workspace`: every live account in the workspace (admins/owners).
 * - `own`: only accounts the actor owns or created — this is what stops a
 *   member from seeing health/renewal data for accounts they cannot read.
 */
export type CsAccountRowScope = { kind: "workspace" } | { kind: "own"; actorId: string }

function accountScopePredicate(scope: CsAccountRowScope): SQL | undefined {
  if (scope.kind === "workspace") return undefined
  return or(eq(csAccounts.ownerId, scope.actorId), eq(csAccounts.createdBy, scope.actorId))
}

/**
 * Account ids visible under `scope`, or `null` for "no restriction"
 * (workspace scope). Used to filter `cs_renewals` / `cs_playbook_tasks`
 * queries that are not already anchored to one pre-validated account id.
 */
async function scopedAccountIds(
  db: Database,
  workspaceId: string,
  scope: CsAccountRowScope,
): Promise<string[] | null> {
  if (scope.kind === "workspace") return null
  const rows = await db
    .select({ id: csAccounts.id })
    .from(csAccounts)
    .where(
      and(
        eq(csAccounts.workspaceId, workspaceId),
        isNull(csAccounts.deletedAt),
        eq(csAccounts.ownerId, scope.actorId),
      ),
    )
  const createdRows = await db
    .select({ id: csAccounts.id })
    .from(csAccounts)
    .where(
      and(
        eq(csAccounts.workspaceId, workspaceId),
        isNull(csAccounts.deletedAt),
        eq(csAccounts.createdBy, scope.actorId),
      ),
    )
  return [...new Set([...rows.map((r) => r.id), ...createdRows.map((r) => r.id)])]
}

/* ---------------------------- health scoring ---------------------------- */

/** Trailing window "ticket volume" and recency read from `activities`. */
export const CS_HEALTH_LOOKBACK_DAYS = 90

const CS_HEALTH_WEIGHTS = { recency: 0.4, ticketVolume: 0.3, openDeals: 0.3 } as const

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export type CsHealthFactor = {
  key: string
  label: string
  rawValue: number | null
  normalizedScore: number
  weight: number
  contribution: number
}

export type CsHealthComputation = { score: number; factors: CsHealthFactor[] }

/**
 * Compute health factors for one account's company, read-only, from tables
 * this module does not own. `workspaceId` and `companyId` are always bound
 * query parameters; the factor set is the fixed registry below, never
 * driven by a caller-supplied field name — same discipline as
 * `reports-repository.ts`'s SECURITY MODEL.
 *
 * "Ticket volume": no ticketing table is merged into this branch yet (spec
 * 21-support.md is a separate module agent's scope, out of this worktree).
 * Until it lands, ticket volume is approximated by counting `activities`
 * logged against the account's company in the lookback window — the
 * closest already-existing proxy for customer-contact volume. Swapping in
 * a real ticket count later only changes the query below; the factor
 * shape, weight and storage stay the same.
 */
export async function computeCsHealthFactors(
  db: Database,
  workspaceId: string,
  companyId: string,
): Promise<CsHealthComputation> {
  const since = new Date(Date.now() - CS_HEALTH_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)

  const companyActivity = and(
    eq(activities.workspaceId, workspaceId),
    eq(activities.subjectType, "company"),
    eq(activities.subjectId, companyId),
    isNull(activities.deletedAt),
  )

  const [lastActivityRow] = await db
    .select({ lastActivityAt: max(activities.createdAt) })
    .from(activities)
    .where(companyActivity)

  const [recentActivityRow] = await db
    .select({ count: count() })
    .from(activities)
    .where(and(companyActivity, gte(activities.createdAt, since)))

  const [openDealsRow] = await db
    .select({ count: count() })
    .from(deals)
    .where(
      and(
        eq(deals.workspaceId, workspaceId),
        eq(deals.companyId, companyId),
        isNull(deals.deletedAt),
        inArray(deals.stage, OPEN_DEAL_STAGES as readonly string[]),
      ),
    )

  const lastActivityAt = lastActivityRow?.lastActivityAt ?? null
  const recencyDays =
    lastActivityAt === null
      ? null
      : Math.floor((Date.now() - new Date(lastActivityAt).getTime()) / 86_400_000)
  const recencyScore =
    recencyDays === null ? 0 : clamp(100 - (recencyDays * 100) / CS_HEALTH_LOOKBACK_DAYS, 0, 100)

  const ticketVolume = recentActivityRow?.count ?? 0
  const ticketVolumeScore = clamp(100 - ticketVolume * 8, 0, 100)

  const openDeals = openDealsRow?.count ?? 0
  const openDealsScore = clamp(Math.min(openDeals, 4) * 25, 0, 100)

  const factors: CsHealthFactor[] = [
    {
      key: "last_activity_recency",
      label: "Recency of last activity",
      rawValue: recencyDays,
      normalizedScore: round2(recencyScore),
      weight: CS_HEALTH_WEIGHTS.recency,
      contribution: round2(recencyScore * CS_HEALTH_WEIGHTS.recency),
    },
    {
      key: "ticket_volume",
      label: `Contact volume (last ${CS_HEALTH_LOOKBACK_DAYS}d)`,
      rawValue: ticketVolume,
      normalizedScore: round2(ticketVolumeScore),
      weight: CS_HEALTH_WEIGHTS.ticketVolume,
      contribution: round2(ticketVolumeScore * CS_HEALTH_WEIGHTS.ticketVolume),
    },
    {
      key: "open_deals",
      label: "Open deals",
      rawValue: openDeals,
      normalizedScore: round2(openDealsScore),
      weight: CS_HEALTH_WEIGHTS.openDeals,
      contribution: round2(openDealsScore * CS_HEALTH_WEIGHTS.openDeals),
    },
  ]

  const score = clamp(round2(factors.reduce((sum, factor) => sum + factor.contribution, 0)), 0, 100)
  return { score, factors }
}

/* ------------------------------ validation ------------------------------ */

export type CreateCsAccountInput = {
  companyId: string
  ownerId?: string | null
  lifecycleStage?: string | null
  arr?: string | number | null
  renewalDate?: string | null
  notes?: string | null
}

export type UpdateCsAccountInput = Partial<Omit<CreateCsAccountInput, "companyId">>

export type CreateCsRenewalInput = {
  accountId: string
  renewalDate: string
  arr?: string | number | null
  ownerId?: string | null
  status?: string | null
  riskFlag?: boolean | null
  notes?: string | null
}

export type UpdateCsRenewalInput = Partial<Omit<CreateCsRenewalInput, "accountId">>

/** NUMERIC(14,2) as a plain decimal string; null clears the value. */
function normalizeCsAmount(
  value: string | number | null | undefined,
  field: string,
): string | null {
  if (value === null || value === undefined) return null
  const num = typeof value === "number" ? value : Number(String(value).trim())
  if (!Number.isFinite(num)) throw new Error(`customer-success: ${field} must be a number`)
  if (num < 0) throw new Error(`customer-success: ${field} must be zero or more`)
  if (num >= 1_000_000_000_000) throw new Error(`customer-success: ${field} is too large`)
  return num.toFixed(2)
}

/** YYYY-MM-DD calendar date (mirrors the DATE column); null clears it. */
function normalizeCsDate(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || value.trim() === "") return null
  const trimmed = value.trim().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`customer-success: ${field} must be YYYY-MM-DD`)
  }
  if (Number.isNaN(new Date(`${trimmed}T00:00:00Z`).getTime())) {
    throw new Error(`customer-success: ${field} is invalid`)
  }
  return trimmed
}

function normalizeCsLifecycleStage(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === "") return "onboarding"
  const trimmed = value.trim()
  if (!isCsLifecycleStage(trimmed)) {
    throw new Error(`customer-success: lifecycleStage must be one of ${CS_LIFECYCLE_STAGE_LIST}`)
  }
  return trimmed
}

const CS_LIFECYCLE_STAGE_LIST = "onboarding, adopting, healthy, at_risk, churned"

function normalizeCsRenewalStatus(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === "") return "open"
  const trimmed = value.trim()
  if (!isCsRenewalStatus(trimmed)) {
    throw new Error("customer-success: renewal status must be one of open, won, lost")
  }
  return trimmed
}

function toCsAccountValues(
  workspaceId: string,
  input: CreateCsAccountInput | UpdateCsAccountInput,
  actorId?: string,
): Partial<NewCsAccount> {
  const values: Partial<NewCsAccount> = {}
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.lifecycleStage !== undefined) {
    values.lifecycleStage = normalizeCsLifecycleStage(input.lifecycleStage)
  }
  if (input.arr !== undefined) values.arr = normalizeCsAmount(input.arr, "arr")
  if (input.renewalDate !== undefined) {
    values.renewalDate = normalizeCsDate(input.renewalDate, "renewalDate")
  }
  if (input.notes !== undefined) values.notes = input.notes
  if (actorId !== undefined) values.updatedBy = actorId
  return { ...values, workspaceId }
}

function toCsRenewalValues(
  workspaceId: string,
  input: CreateCsRenewalInput | UpdateCsRenewalInput,
  actorId?: string,
): Partial<NewCsRenewal> {
  const values: Partial<NewCsRenewal> = {}
  if (input.renewalDate !== undefined) {
    const date = normalizeCsDate(input.renewalDate, "renewalDate")
    if (date === null) throw new Error("customer-success: renewalDate must not be empty")
    values.renewalDate = date
  }
  if (input.arr !== undefined) values.arr = normalizeCsAmount(input.arr, "arr")
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.status !== undefined) values.status = normalizeCsRenewalStatus(input.status)
  if (input.riskFlag !== undefined) values.riskFlag = input.riskFlag ?? false
  if (input.notes !== undefined) values.notes = input.notes
  if (actorId !== undefined) values.updatedBy = actorId
  return { ...values, workspaceId }
}

/* ------------------------------ repository ------------------------------ */

export function createCustomerSuccessRepository() {
  const accountsBase = createBaseRepository(csAccounts)
  const renewalsBase = createBaseRepository(csRenewals)

  const accounts = {
    ...accountsBase,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateCsAccountInput,
      actorId?: string,
    ): Promise<CsAccount> {
      if (!input.companyId || input.companyId.trim() === "") {
        throw new Error("customer-success: companyId is required")
      }
      const rows = await db
        .insert(csAccounts)
        .values({
          ...toCsAccountValues(workspaceId, input, actorId),
          workspaceId,
          companyId: input.companyId,
          lifecycleStage: normalizeCsLifecycleStage(input.lifecycleStage),
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("cs_accounts.create: insert returned no rows")
      return row
    },

    /** Cursor-paginated list, filtered by what the caller may see. */
    async search(
      db: Database,
      opts: {
        workspaceId: string
        limit?: number
        cursor?: string
        order?: "asc" | "desc"
        lifecycleStage?: string
        scope: CsAccountRowScope
      },
    ) {
      const conditions: SQL[] = []
      if (opts.lifecycleStage) {
        if (!isCsLifecycleStage(opts.lifecycleStage)) {
          throw new Error("customer-success: unknown lifecycleStage filter")
        }
        conditions.push(eq(csAccounts.lifecycleStage, opts.lifecycleStage))
      }
      const scoped = accountScopePredicate(opts.scope)
      if (scoped) conditions.push(scoped)
      const result = await accountsBase.list(db, {
        workspaceId: opts.workspaceId,
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
        ...(opts.order === undefined ? {} : { order: opts.order }),
        where: conditions,
      })
      return { data: result.data as CsAccount[], pagination: result.pagination }
    },

    /** Scoped single-row lookup: a row outside `scope` reads as not found. */
    async findById(
      db: Database,
      workspaceId: string,
      id: string,
      scope: CsAccountRowScope,
    ): Promise<CsAccount | null> {
      const conditions: SQL[] = [
        eq(csAccounts.id, id),
        eq(csAccounts.workspaceId, workspaceId),
        isNull(csAccounts.deletedAt),
      ]
      const scoped = accountScopePredicate(scope)
      if (scoped) conditions.push(scoped)
      const rows = await db
        .select()
        .from(csAccounts)
        .where(and(...conditions))
        .limit(1)
      return rows[0] ?? null
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateCsAccountInput,
      actorId?: string,
    ): Promise<CsAccount | null> {
      const rows = await db
        .update(csAccounts)
        .set({ ...toCsAccountValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(csAccounts.id, id),
            eq(csAccounts.workspaceId, workspaceId),
            isNull(csAccounts.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },
  }

  const healthScores = {
    computeFactors: (db: Database, workspaceId: string, companyId: string) =>
      computeCsHealthFactors(db, workspaceId, companyId),

    /** Store one computation as a new, immutable history row. */
    async record(
      db: Database,
      workspaceId: string,
      accountId: string,
      computation: CsHealthComputation,
      actorId?: string,
    ): Promise<CsHealthScore> {
      const rows = await db
        .insert(csHealthScores)
        .values({
          workspaceId,
          accountId,
          score: computation.score.toFixed(2),
          factors: computation.factors,
          computedBy: actorId ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("cs_health_scores.record: insert returned no rows")
      return row
    },

    /** Newest-first history for one (already-visibility-checked) account. */
    async listForAccount(
      db: Database,
      workspaceId: string,
      accountId: string,
      limit = 50,
    ): Promise<CsHealthScore[]> {
      return db
        .select()
        .from(csHealthScores)
        .where(
          and(eq(csHealthScores.workspaceId, workspaceId), eq(csHealthScores.accountId, accountId)),
        )
        .orderBy(desc(csHealthScores.computedAt))
        .limit(Math.min(Math.max(limit, 1), 200))
    },

    async latestForAccount(
      db: Database,
      workspaceId: string,
      accountId: string,
    ): Promise<CsHealthScore | null> {
      const rows = await healthScores.listForAccount(db, workspaceId, accountId, 1)
      return rows[0] ?? null
    },
  }

  const renewals = {
    ...renewalsBase,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateCsRenewalInput,
      actorId?: string,
    ): Promise<CsRenewal> {
      if (!input.accountId || input.accountId.trim() === "") {
        throw new Error("customer-success: accountId is required")
      }
      const renewalDate = normalizeCsDate(input.renewalDate, "renewalDate")
      if (renewalDate === null) throw new Error("customer-success: renewalDate is required")
      const rows = await db
        .insert(csRenewals)
        .values({
          workspaceId,
          accountId: input.accountId,
          renewalDate,
          arr: normalizeCsAmount(input.arr, "arr"),
          ownerId: input.ownerId ?? null,
          status: normalizeCsRenewalStatus(input.status),
          riskFlag: input.riskFlag ?? false,
          notes: input.notes ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("cs_renewals.create: insert returned no rows")
      return row
    },

    /** Cursor-paginated list, filtered by what the caller may see. */
    async search(
      db: Database,
      opts: {
        workspaceId: string
        limit?: number
        cursor?: string
        order?: "asc" | "desc"
        accountId?: string
        status?: string
        riskFlag?: boolean
        /** Only renewals due within N days from now (inclusive). */
        withinDays?: number
        scope: CsAccountRowScope
      },
    ) {
      const conditions: SQL[] = []
      if (opts.accountId) conditions.push(eq(csRenewals.accountId, opts.accountId))
      if (opts.status) {
        if (!isCsRenewalStatus(opts.status)) {
          throw new Error("customer-success: unknown renewal status filter")
        }
        conditions.push(eq(csRenewals.status, opts.status))
      }
      if (opts.riskFlag !== undefined) conditions.push(eq(csRenewals.riskFlag, opts.riskFlag))
      if (opts.withinDays !== undefined) {
        const today = new Date().toISOString().slice(0, 10)
        const until = new Date(Date.now() + opts.withinDays * 86_400_000).toISOString().slice(0, 10)
        conditions.push(gte(csRenewals.renewalDate, today))
        conditions.push(lte(csRenewals.renewalDate, until))
      }
      const ids = await scopedAccountIds(db, opts.workspaceId, opts.scope)
      if (ids !== null) {
        if (ids.length === 0) {
          return {
            data: [] as CsRenewal[],
            pagination: { nextCursor: null, limit: opts.limit ?? 25 },
          }
        }
        conditions.push(inArray(csRenewals.accountId, ids))
      }
      const result = await renewalsBase.list(db, {
        workspaceId: opts.workspaceId,
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
        ...(opts.order === undefined ? {} : { order: opts.order }),
        where: conditions,
      })
      return { data: result.data as CsRenewal[], pagination: result.pagination }
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<CsRenewal | null> {
      const row = await renewalsBase.findById(db, workspaceId, id)
      return (row as CsRenewal | null) ?? null
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateCsRenewalInput,
      actorId?: string,
    ): Promise<CsRenewal | null> {
      const rows = await db
        .update(csRenewals)
        .set({ ...toCsRenewalValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(csRenewals.id, id),
            eq(csRenewals.workspaceId, workspaceId),
            isNull(csRenewals.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },
  }

  const playbookTasks = {
    /** Record the link between an applied playbook and the task it created. */
    async recordApplication(
      db: Database,
      workspaceId: string,
      accountId: string,
      playbookKey: string,
      taskId: string,
      actorId?: string,
    ): Promise<CsPlaybookTask> {
      // Defense in depth: re-validate against the allowlist here too, so a
      // link row can never be written for a key the registry doesn't know,
      // even if a future caller skips the service-layer lookup.
      const playbook = resolveCsPlaybook(playbookKey)
      const rows = await db
        .insert(csPlaybookTasks)
        .values({
          workspaceId,
          accountId,
          playbookKey: playbook.key,
          taskId,
          appliedBy: actorId ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("cs_playbook_tasks.recordApplication: insert returned no rows")
      return row
    },

    /** All playbook-task links for one (already-visibility-checked) account. */
    async listForAccount(
      db: Database,
      workspaceId: string,
      accountId: string,
    ): Promise<CsPlaybookTask[]> {
      return db
        .select()
        .from(csPlaybookTasks)
        .where(
          and(
            eq(csPlaybookTasks.workspaceId, workspaceId),
            eq(csPlaybookTasks.accountId, accountId),
            isNull(csPlaybookTasks.deletedAt),
          ),
        )
        .orderBy(desc(csPlaybookTasks.appliedAt))
    },
  }

  return { accounts, healthScores, renewals, playbookTasks }
}

export type CustomerSuccessRepository = ReturnType<typeof createCustomerSuccessRepository>
