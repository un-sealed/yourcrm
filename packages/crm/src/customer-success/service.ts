import { requirePermission } from "@yourcrm/permissions"
import { csPermission, resolveAccountRowScope } from "./access"
import {
  applyCsPlaybookSchema,
  createCsAccountSchema,
  createCsRenewalSchema,
  csAccountQuerySchema,
  csRenewalQuerySchema,
  updateCsAccountSchema,
  updateCsRenewalSchema,
} from "./schemas"
import type {
  CsAccountListResult,
  CsAccountRecord,
  CsHealthScoreRecord,
  CsPlaybookCatalogEntry,
  CsPlaybookTaskRecord,
  CsRenewalListResult,
  CsRenewalRecord,
  CustomerSuccessServiceContext,
  CustomerSuccessServiceDeps,
} from "./types"

export class CsAccountNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`customer success account ${id} not found`)
    this.name = "CsAccountNotFoundError"
  }
}

export class CsRenewalNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`renewal ${id} not found`)
    this.name = "CsRenewalNotFoundError"
  }
}

export class CsPlaybookNotFoundError extends Error {
  readonly code = "INVALID_PLAYBOOK"
  constructor(key: string) {
    super(`unknown playbook '${key}'`)
    this.name = "CsPlaybookNotFoundError"
  }
}

/** Playbook task templates run relative to "now", in days. */
function dueDateFromOffset(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Customer Success domain service (spec 46-customer-success, P0), mirroring
 * the `people` reference module and `reports`' permission-filtered
 * aggregation pattern.
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. for account-shaped resources, resolves `CsAccountRowScope` from the
 *     caller (`access.ts`) and threads it into the store call, or loads the
 *     parent account through that scope before touching a child resource
 *     (health score / renewal / playbook task) — a record outside the
 *     caller's scope reads as NOT_FOUND, never leaks via a 403;
 *  3. does the work through the injected `CustomerSuccessStore` port;
 *  4. writes the audit row with before/after (mutations only). See
 *     `types.ts` for why there is no domain-event emission here yet.
 */
export function createCustomerSuccessService(deps: CustomerSuccessServiceDeps) {
  async function loadAccount(
    ctx: CustomerSuccessServiceContext,
    id: string,
  ): Promise<CsAccountRecord> {
    const account = await deps.store.findAccountById(
      ctx.workspaceId,
      id,
      resolveAccountRowScope(ctx),
    )
    if (!account) throw new CsAccountNotFoundError(id)
    return account
  }

  async function loadRenewal(
    ctx: CustomerSuccessServiceContext,
    id: string,
  ): Promise<CsRenewalRecord> {
    const renewal = await deps.store.findRenewalById(ctx.workspaceId, id)
    if (!renewal) throw new CsRenewalNotFoundError(id)
    // A renewal is only visible if its account is: same scope rule as the
    // account itself, applied one hop away.
    await loadAccount(ctx, renewal.accountId)
    return renewal
  }

  async function listAccounts(
    ctx: CustomerSuccessServiceContext,
    rawQuery: unknown,
  ): Promise<CsAccountListResult> {
    requirePermission(csPermission(ctx, "read"))
    const query = csAccountQuerySchema.parse(rawQuery)
    const result = await deps.store.listAccounts(
      ctx.workspaceId,
      query,
      resolveAccountRowScope(ctx),
    )
    // Enrich each row with its latest health score for the list view
    // (health + renewal columns). One extra lookup per row, bounded by the
    // page size (<=200) — acceptable for P0; a join-based projection is the
    // natural follow-up if this page ever needs to scale past that.
    const data = await Promise.all(
      result.data.map(async (account) => {
        const [latest] = await deps.store.listHealthScores(ctx.workspaceId, account.id, 1)
        return { ...account, latestHealthScore: latest ?? null }
      }),
    )
    return { ...result, data }
  }

  async function getAccount(
    ctx: CustomerSuccessServiceContext,
    id: string,
  ): Promise<CsAccountRecord> {
    requirePermission(csPermission(ctx, "read"))
    return loadAccount(ctx, id)
  }

  async function createAccount(
    ctx: CustomerSuccessServiceContext,
    rawInput: unknown,
  ): Promise<CsAccountRecord> {
    requirePermission(csPermission(ctx, "create"))
    const input = createCsAccountSchema.parse(rawInput)
    const account = await deps.store.createAccount(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "cs_account",
      recordId: account.id,
      after: account,
      correlationId: ctx.correlationId,
    })
    return account
  }

  async function updateAccount(
    ctx: CustomerSuccessServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<CsAccountRecord> {
    requirePermission(csPermission(ctx, "update"))
    const patch = updateCsAccountSchema.parse(rawPatch)
    const before = await loadAccount(ctx, id)
    const after = await deps.store.updateAccount(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new CsAccountNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "cs_account",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function deleteAccount(
    ctx: CustomerSuccessServiceContext,
    id: string,
  ): Promise<CsAccountRecord> {
    requirePermission(csPermission(ctx, "delete"))
    const before = await loadAccount(ctx, id)
    await deps.store.softDeleteAccount(ctx.workspaceId, id, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "cs_account",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restoreAccount(
    ctx: CustomerSuccessServiceContext,
    id: string,
  ): Promise<CsAccountRecord> {
    requirePermission(csPermission(ctx, "update"))
    await deps.store.restoreAccount(ctx.workspaceId, id)
    const after = await loadAccount(ctx, id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "cs_account",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Recompute and store a new health-score history row for one account.
   * Read side (`activities`, `deals`) is permission-blind by construction —
   * it only ever reads the ONE company this caller's account resolves to,
   * and the account lookup above is what enforces "a member must not see
   * health for accounts they cannot read."
   */
  async function recomputeHealthScore(
    ctx: CustomerSuccessServiceContext,
    accountId: string,
  ): Promise<CsHealthScoreRecord> {
    requirePermission(csPermission(ctx, "update"))
    const account = await loadAccount(ctx, accountId)
    const companyId = String(account.companyId ?? "")
    const computation = await deps.store.computeHealthFactors(ctx.workspaceId, companyId)
    const score = await deps.store.recordHealthScore(
      ctx.workspaceId,
      accountId,
      computation,
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "compute",
      object: "cs_health_score",
      recordId: score.id,
      after: score,
      correlationId: ctx.correlationId,
    })
    return score
  }

  async function listHealthScores(
    ctx: CustomerSuccessServiceContext,
    accountId: string,
  ): Promise<CsHealthScoreRecord[]> {
    requirePermission(csPermission(ctx, "read"))
    await loadAccount(ctx, accountId)
    return deps.store.listHealthScores(ctx.workspaceId, accountId)
  }

  async function listRenewals(
    ctx: CustomerSuccessServiceContext,
    rawQuery: unknown,
  ): Promise<CsRenewalListResult> {
    requirePermission(csPermission(ctx, "read"))
    const query = csRenewalQuerySchema.parse(rawQuery)
    return deps.store.listRenewals(ctx.workspaceId, query, resolveAccountRowScope(ctx))
  }

  async function getRenewal(
    ctx: CustomerSuccessServiceContext,
    id: string,
  ): Promise<CsRenewalRecord> {
    requirePermission(csPermission(ctx, "read"))
    return loadRenewal(ctx, id)
  }

  async function createRenewal(
    ctx: CustomerSuccessServiceContext,
    rawInput: unknown,
  ): Promise<CsRenewalRecord> {
    requirePermission(csPermission(ctx, "create"))
    const input = createCsRenewalSchema.parse(rawInput)
    // The account must be visible to the caller before a renewal can be
    // attached to it.
    await loadAccount(ctx, input.accountId)
    const renewal = await deps.store.createRenewal(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "cs_renewal",
      recordId: renewal.id,
      after: renewal,
      correlationId: ctx.correlationId,
    })
    return renewal
  }

  async function updateRenewal(
    ctx: CustomerSuccessServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<CsRenewalRecord> {
    requirePermission(csPermission(ctx, "update"))
    const patch = updateCsRenewalSchema.parse(rawPatch)
    const before = await loadRenewal(ctx, id)
    const after = await deps.store.updateRenewal(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new CsRenewalNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "cs_renewal",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /** Playbook catalogue for the web picker. Read permission is enough. */
  function listPlaybooks(ctx: CustomerSuccessServiceContext): CsPlaybookCatalogEntry[] {
    requirePermission(csPermission(ctx, "read"))
    return deps.store.describePlaybooks()
  }

  /**
   * Apply a named playbook to an account: one real task per template,
   * created through `TasksPort` (the tasks module's own service — see
   * `types.ts`), plus one `cs_playbook_tasks` link row per task so the
   * account detail page can show what a playbook run did without this
   * module re-implementing task storage.
   */
  async function applyPlaybook(
    ctx: CustomerSuccessServiceContext,
    accountId: string,
    rawInput: unknown,
  ): Promise<CsPlaybookTaskRecord[]> {
    requirePermission(csPermission(ctx, "create"))
    const input = applyCsPlaybookSchema.parse(rawInput)
    const account = await loadAccount(ctx, accountId)
    const playbook = deps.store.getPlaybook(input.playbookKey)
    if (!playbook) throw new CsPlaybookNotFoundError(input.playbookKey)

    const links: CsPlaybookTaskRecord[] = []
    for (const template of playbook.tasks) {
      const task = await deps.tasks.createTask(ctx, {
        title: template.title,
        description: template.description ?? null,
        dueDate: dueDateFromOffset(template.dueOffsetDays),
        priority: template.priority,
        companyId: (account.companyId as string | null) ?? null,
      })
      const link = await deps.store.recordPlaybookApplication(
        ctx.workspaceId,
        accountId,
        playbook.key,
        task.id,
        ctx.actorId,
      )
      links.push(link)
    }

    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "apply_playbook",
      object: "cs_playbook_application",
      recordId: accountId,
      after: { playbookKey: playbook.key, taskIds: links.map((l) => l.taskId) },
      correlationId: ctx.correlationId,
    })
    return links
  }

  async function listPlaybookTasks(
    ctx: CustomerSuccessServiceContext,
    accountId: string,
  ): Promise<{ links: CsPlaybookTaskRecord[]; tasks: Record<string, unknown>[] }> {
    requirePermission(csPermission(ctx, "read"))
    await loadAccount(ctx, accountId)
    const links = await deps.store.listPlaybookTasks(ctx.workspaceId, accountId)
    const tasks =
      links.length === 0
        ? []
        : await deps.tasks.getTasks(
            ctx,
            links.map((l) => l.taskId),
          )
    return { links, tasks }
  }

  return {
    listAccounts,
    getAccount,
    createAccount,
    updateAccount,
    deleteAccount,
    restoreAccount,
    recomputeHealthScore,
    listHealthScores,
    listRenewals,
    getRenewal,
    createRenewal,
    updateRenewal,
    listPlaybooks,
    applyPlaybook,
    listPlaybookTasks,
  }
}

export type CustomerSuccessService = ReturnType<typeof createCustomerSuccessService>
