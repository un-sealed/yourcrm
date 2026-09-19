import type { ServiceContext } from "../index"
import type { AuditWriter } from "../ports"

/**
 * Customer Success service ports (mirrors the `people` reference module and
 * `reports` for the allowlisted, permission-scoped aggregation pieces).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the
 * API layer adapts the drizzle repository
 * (`customer-success-repository.ts`) and `writeAudit` to them, and the
 * hermetic test fakes satisfy them the same way.
 *
 * NO `EventEmitter` PORT HERE ON PURPOSE. Every other module emits its
 * mutations through a `<Domain>Events` constant from `@yourcrm/events`
 * (`CrmEvents`, `ReportEvents`, ...) — there is no `CsEvents` group in that
 * package. Inventing `cs.account.created` etc. as string literals would
 * violate the "no string literals, allowlist only" rule this module is
 * held to, so account/health-score/renewal/playbook mutations write an
 * audit row (via `AuditWriter` below) but do not emit a domain event in
 * P0. This is a reported blocker, not a silent gap — see the module
 * report. Playbook task application is the one exception: it goes through
 * the tasks module's own service via `TasksPort`, so a real
 * `CrmEvents.TaskCreated` event still fires for every task it creates.
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type CsAccountRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type CsHealthScoreRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  accountId: string
}

export type CsRenewalRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  accountId: string
}

export type CsPlaybookTaskRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  accountId: string
  taskId: string
}

/**
 * Account visibility for one query, derived by `resolveAccountRowScope`
 * (`access.ts`) from the caller's permissions and never accepted from
 * request input. Structural twin of `CsAccountRowScope` in
 * `customer-success-repository.ts` — same reasoning as `ReportRowScope`
 * being restated in both `@yourcrm/crm` and `@yourcrm/database`.
 */
export type CsAccountRowScope = { kind: "workspace" } | { kind: "own"; actorId: string }

export type CsAccountListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  lifecycleStage?: string
}

export type CsAccountListResult = {
  data: CsAccountRecord[]
  pagination: { nextCursor: string | null; limit: number }
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

export type CsRenewalListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  accountId?: string
  status?: string
  riskFlag?: boolean
  withinDays?: number
}

export type CsRenewalListResult = {
  data: CsRenewalRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type CsPlaybookTaskTemplate = {
  title: string
  description?: string
  dueOffsetDays: number
  priority: "low" | "medium" | "high" | "urgent"
}

export type CsPlaybookDefinition = {
  key: string
  label: string
  description: string
  tasks: readonly CsPlaybookTaskTemplate[]
}

export type CsPlaybookCatalogEntry = {
  key: string
  label: string
  description: string
  taskCount: number
}

export type CustomerSuccessStore = {
  listAccounts(
    workspaceId: string,
    query: CsAccountListQuery,
    scope: CsAccountRowScope,
  ): Promise<CsAccountListResult>
  findAccountById(
    workspaceId: string,
    id: string,
    scope: CsAccountRowScope,
  ): Promise<CsAccountRecord | null>
  createAccount(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<CsAccountRecord>
  updateAccount(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<CsAccountRecord | null>
  softDeleteAccount(workspaceId: string, id: string, actorId?: string): Promise<void>
  restoreAccount(workspaceId: string, id: string): Promise<void>

  /** Read-only aggregation over other modules' tables (activities, deals). */
  computeHealthFactors(workspaceId: string, companyId: string): Promise<CsHealthComputation>
  recordHealthScore(
    workspaceId: string,
    accountId: string,
    computation: CsHealthComputation,
    actorId?: string,
  ): Promise<CsHealthScoreRecord>
  listHealthScores(
    workspaceId: string,
    accountId: string,
    limit?: number,
  ): Promise<CsHealthScoreRecord[]>

  listRenewals(
    workspaceId: string,
    query: CsRenewalListQuery,
    scope: CsAccountRowScope,
  ): Promise<CsRenewalListResult>
  findRenewalById(workspaceId: string, id: string): Promise<CsRenewalRecord | null>
  createRenewal(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<CsRenewalRecord>
  updateRenewal(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<CsRenewalRecord | null>

  describePlaybooks(): CsPlaybookCatalogEntry[]
  /** Allowlist lookup; `null` for an unknown key (never throws). */
  getPlaybook(playbookKey: string): CsPlaybookDefinition | null
  recordPlaybookApplication(
    workspaceId: string,
    accountId: string,
    playbookKey: string,
    taskId: string,
    actorId?: string,
  ): Promise<CsPlaybookTaskRecord>
  listPlaybookTasks(workspaceId: string, accountId: string): Promise<CsPlaybookTaskRecord[]>
}

/**
 * Narrow port onto the tasks module — the mechanism that lets playbooks
 * reuse the real task engine instead of duplicating one. The API layer
 * wires this to the actual `createTasksService` (`@yourcrm/crm/src/tasks`),
 * so a playbook-created task still runs through normal task validation,
 * audit and `CrmEvents.TaskCreated`.
 */
export type PlaybookTaskInput = {
  title: string
  description?: string | null
  dueDate?: string | null
  priority?: string | null
  companyId?: string | null
}

export type PlaybookTaskRecord = Record<string, unknown> & { id: string }

export type TasksPort = {
  createTask(
    ctx: CustomerSuccessServiceContext,
    input: PlaybookTaskInput,
  ): Promise<PlaybookTaskRecord>
  /** Best-effort bulk fetch for display; missing/inaccessible ids are omitted. */
  getTasks(ctx: CustomerSuccessServiceContext, ids: string[]): Promise<PlaybookTaskRecord[]>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type CsAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type CustomerSuccessServiceContext = ServiceContext

export type CustomerSuccessServiceDeps = {
  store: CustomerSuccessStore
  tasks: TasksPort
  audit: AuditWriter<CsAuditInput>
}
