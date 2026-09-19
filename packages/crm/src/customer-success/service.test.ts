import { beforeEach, describe, expect, test } from "bun:test"
import {
  createStore,
  expectAllowed,
  expectDenied,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import {
  CsAccountNotFoundError,
  CsPlaybookNotFoundError,
  createCustomerSuccessService,
  type CustomerSuccessService,
} from "./index"
import type {
  CsAccountRecord,
  CsAccountRowScope,
  CsHealthComputation,
  CsHealthScoreRecord,
  CsPlaybookCatalogEntry,
  CsPlaybookDefinition,
  CsPlaybookTaskRecord,
  CsRenewalRecord,
  CustomerSuccessStore,
  PlaybookTaskInput,
  PlaybookTaskRecord,
  TasksPort,
} from "./types"

type StoredAccount = BaseRecord & {
  companyId: string
  ownerId: string | null
  lifecycleStage: string
  arr: string | null
  renewalDate: string | null
  notes: string | null
}

type StoredHealthScore = BaseRecord & {
  accountId: string
  score: string
  factors: unknown
  computedAt: string
  computedBy: string | null
}

type StoredRenewal = BaseRecord & {
  accountId: string
  renewalDate: string
  arr: string | null
  ownerId: string | null
  status: string
  riskFlag: boolean
  notes: string | null
}

type StoredPlaybookTask = BaseRecord & {
  accountId: string
  playbookKey: string
  taskId: string
  appliedBy: string | null
}

const PLAYBOOKS: Record<string, CsPlaybookDefinition> = {
  onboarding: {
    key: "onboarding",
    label: "Onboarding",
    description: "First-30-days plan.",
    tasks: [
      { title: "Kickoff call", dueOffsetDays: 3, priority: "high" },
      { title: "30-day check-in", dueOffsetDays: 30, priority: "medium" },
    ],
  },
}

const DEFAULT_COMPUTATION: CsHealthComputation = {
  score: 82.5,
  factors: [
    {
      key: "last_activity_recency",
      label: "Recency of last activity",
      rawValue: 4,
      normalizedScore: 95.56,
      weight: 0.4,
      contribution: 38.22,
    },
    {
      key: "ticket_volume",
      label: "Contact volume (last 90d)",
      rawValue: 1,
      normalizedScore: 92,
      weight: 0.3,
      contribution: 27.6,
    },
    {
      key: "open_deals",
      label: "Open deals",
      rawValue: 1,
      normalizedScore: 25,
      weight: 0.3,
      contribution: 7.5,
    },
  ],
}

function asAccount(row: StoredAccount): CsAccountRecord {
  return row as unknown as CsAccountRecord
}

function asRenewal(row: StoredRenewal): CsRenewalRecord {
  return row as unknown as CsRenewalRecord
}

function asHealthScore(row: StoredHealthScore): CsHealthScoreRecord {
  return row as unknown as CsHealthScoreRecord
}

function asPlaybookTask(row: StoredPlaybookTask): CsPlaybookTaskRecord {
  return row as unknown as CsPlaybookTaskRecord
}

/** Hermetic store: honours `CsAccountRowScope` the way the drizzle repository does. */
function makeStore() {
  const accounts = createStore<StoredAccount>()
  const healthScores = createStore<StoredHealthScore>()
  const renewals = createStore<StoredRenewal>()
  const playbookTasks = createStore<StoredPlaybookTask>()

  function inScope(row: StoredAccount, scope: CsAccountRowScope): boolean {
    if (scope.kind === "workspace") return true
    return row.ownerId === scope.actorId || row.createdBy === scope.actorId
  }

  const store: CustomerSuccessStore = {
    listAccounts: async (workspaceId, query, scope) => {
      let rows = accounts.list(workspaceId).filter((row) => inScope(row, scope))
      if (query.lifecycleStage) rows = rows.filter((r) => r.lifecycleStage === query.lifecycleStage)
      const limit = query.limit ?? 25
      const data = rows.slice(0, limit)
      return {
        data: data.map(asAccount),
        pagination: { nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null, limit },
      }
    },
    findAccountById: async (workspaceId, id, scope) => {
      const row = accounts.get(id, workspaceId)
      if (!row || !inScope(row, scope)) return null
      return asAccount(row)
    },
    createAccount: async (workspaceId, input, actorId) => {
      return asAccount(
        accounts.insert({
          ...makeBaseRecord({ workspaceId }),
          companyId: input.companyId as string,
          ownerId: (input.ownerId as string | null) ?? null,
          lifecycleStage: (input.lifecycleStage as string | null) ?? "onboarding",
          arr: null,
          renewalDate: null,
          notes: null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    updateAccount: async (workspaceId, id, input) => {
      const row = accounts.update(id, workspaceId, input as Partial<StoredAccount>)
      return row ? asAccount(row) : null
    },
    softDeleteAccount: async (workspaceId, id) => {
      accounts.remove(id, workspaceId)
    },
    restoreAccount: async (workspaceId, id) => {
      accounts.restore(id, workspaceId)
    },
    computeHealthFactors: async () => DEFAULT_COMPUTATION,
    recordHealthScore: async (workspaceId, accountId, computation, actorId) => {
      return asHealthScore(
        healthScores.insert({
          ...makeBaseRecord({ workspaceId }),
          accountId,
          score: computation.score.toFixed(2),
          factors: computation.factors,
          computedAt: new Date().toISOString(),
          computedBy: actorId ?? null,
        }),
      )
    },
    listHealthScores: async (workspaceId, accountId) => {
      return healthScores
        .list(workspaceId)
        .filter((row) => row.accountId === accountId)
        .map(asHealthScore)
    },
    listRenewals: async (workspaceId, query, scope) => {
      const scopedAccountIds = new Set(
        accounts
          .list(workspaceId)
          .filter((row) => inScope(row, scope))
          .map((row) => row.id),
      )
      let rows = renewals.list(workspaceId).filter((row) => scopedAccountIds.has(row.accountId))
      if (query.accountId) rows = rows.filter((r) => r.accountId === query.accountId)
      if (query.riskFlag !== undefined) rows = rows.filter((r) => r.riskFlag === query.riskFlag)
      const limit = query.limit ?? 25
      const data = rows.slice(0, limit)
      return {
        data: data.map(asRenewal),
        pagination: { nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null, limit },
      }
    },
    findRenewalById: async (workspaceId, id) => {
      const row = renewals.get(id, workspaceId)
      return row ? asRenewal(row) : null
    },
    createRenewal: async (workspaceId, input, actorId) => {
      return asRenewal(
        renewals.insert({
          ...makeBaseRecord({ workspaceId }),
          accountId: input.accountId as string,
          renewalDate: input.renewalDate as string,
          arr: null,
          ownerId: (input.ownerId as string | null) ?? null,
          status: (input.status as string | null) ?? "open",
          riskFlag: (input.riskFlag as boolean | null) ?? false,
          notes: null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    updateRenewal: async (workspaceId, id, input) => {
      const row = renewals.update(id, workspaceId, input as Partial<StoredRenewal>)
      return row ? asRenewal(row) : null
    },
    describePlaybooks: (): CsPlaybookCatalogEntry[] =>
      Object.values(PLAYBOOKS).map((def) => ({
        key: def.key,
        label: def.label,
        description: def.description,
        taskCount: def.tasks.length,
      })),
    getPlaybook: (key) => PLAYBOOKS[key] ?? null,
    recordPlaybookApplication: async (workspaceId, accountId, playbookKey, taskId, actorId) => {
      return asPlaybookTask(
        playbookTasks.insert({
          ...makeBaseRecord({ workspaceId }),
          accountId,
          playbookKey,
          taskId,
          appliedBy: actorId ?? null,
        }),
      )
    },
    listPlaybookTasks: async (workspaceId, accountId) => {
      return playbookTasks
        .list(workspaceId)
        .filter((row) => row.accountId === accountId)
        .map(asPlaybookTask)
    },
  }
  return store
}

function makeFakeTasksPort() {
  const created: PlaybookTaskInput[] = []
  const tasks = createStore<BaseRecord & { title: string }>()
  const port: TasksPort = {
    createTask: async (ctx, input) => {
      created.push(input)
      const row = tasks.insert({
        ...makeBaseRecord({ workspaceId: ctx.workspaceId }),
        title: input.title,
      })
      return row as unknown as PlaybookTaskRecord
    },
    getTasks: async (ctx, ids) => {
      return tasks
        .list(ctx.workspaceId)
        .filter((row) => ids.includes(row.id)) as unknown as PlaybookTaskRecord[]
    },
  }
  return { port, created }
}

describe("customer-success/service", () => {
  let service: CustomerSuccessService
  let tasksPort: ReturnType<typeof makeFakeTasksPort>
  let auditCalls: unknown[]

  beforeEach(() => {
    tasksPort = makeFakeTasksPort()
    auditCalls = []
    service = createCustomerSuccessService({
      store: makeStore(),
      tasks: tasksPort.port,
      audit: async (input) => {
        auditCalls.push(input)
      },
    })
  })

  test("viewer cannot create an account", async () => {
    const ctx = makeServiceContext({ session: makeSession({ role: "viewer" }) })
    await expectDenied(() => service.createAccount(ctx, { companyId: "company_1" }))
  })

  test("member can create and read their own account", async () => {
    const ctx = makeServiceContext({ session: makeSession({ role: "member" }) })
    const account = await expectAllowed(() =>
      service.createAccount(ctx, { companyId: "company_1", ownerId: ctx.actorId }),
    )
    const found = await expectAllowed(() => service.getAccount(ctx, account.id))
    expect(found.id).toBe(account.id)
    expect(auditCalls).toHaveLength(1)
  })

  test("admin sees every account in the workspace; a member only sees their own", async () => {
    const workspaceId = "ws_shared"
    const adminSession = makeSession({ role: "admin", workspaceId })
    const memberASession = makeSession({ role: "member", workspaceId })
    const memberBSession = makeSession({ role: "member", workspaceId })
    const adminCtx = makeServiceContext({ session: adminSession })
    const memberACtx = makeServiceContext({ session: memberASession })
    const memberBCtx = makeServiceContext({ session: memberBSession })

    const accountA = await service.createAccount(memberACtx, {
      companyId: "company_a",
      ownerId: memberACtx.actorId,
    })
    const accountB = await service.createAccount(memberBCtx, {
      companyId: "company_b",
      ownerId: memberBCtx.actorId,
    })

    const adminList = await service.listAccounts(adminCtx, {})
    expect(adminList.data.map((a) => a.id).sort()).toEqual([accountA.id, accountB.id].sort())

    const memberAList = await service.listAccounts(memberACtx, {})
    expect(memberAList.data.map((a) => a.id)).toEqual([accountA.id])

    // A member cannot read another member's account directly either — it
    // reads as NOT_FOUND, never leaking that the record exists.
    await expect(service.getAccount(memberACtx, accountB.id)).rejects.toBeInstanceOf(
      CsAccountNotFoundError,
    )
  })

  test("recomputeHealthScore stores the factor breakdown and returns the score", async () => {
    const ctx = makeServiceContext({ session: makeSession({ role: "member" }) })
    const account = await service.createAccount(ctx, {
      companyId: "company_1",
      ownerId: ctx.actorId,
    })
    const score = await expectAllowed(() => service.recomputeHealthScore(ctx, account.id))
    expect(score.accountId).toBe(account.id)
    expect(Number(score.score)).toBeCloseTo(82.5)
    expect(score.factors).toEqual(DEFAULT_COMPUTATION.factors)

    const history = await service.listHealthScores(ctx, account.id)
    expect(history).toHaveLength(1)
  })

  test("applyPlaybook creates one real task per template through TasksPort", async () => {
    const ctx = makeServiceContext({ session: makeSession({ role: "member" }) })
    const account = await service.createAccount(ctx, {
      companyId: "company_1",
      ownerId: ctx.actorId,
    })
    const links = await service.applyPlaybook(ctx, account.id, { playbookKey: "onboarding" })
    expect(links).toHaveLength(2)
    expect(tasksPort.created).toHaveLength(2)
    expect(tasksPort.created.map((t) => t.title)).toEqual(["Kickoff call", "30-day check-in"])

    const { links: stored, tasks } = await service.listPlaybookTasks(ctx, account.id)
    expect(stored).toHaveLength(2)
    expect(tasks).toHaveLength(2)
  })

  test("applyPlaybook rejects an unknown playbook key before touching TasksPort", async () => {
    const ctx = makeServiceContext({ session: makeSession({ role: "member" }) })
    const account = await service.createAccount(ctx, {
      companyId: "company_1",
      ownerId: ctx.actorId,
    })
    await expect(
      service.applyPlaybook(ctx, account.id, { playbookKey: "not-a-real-playbook" }),
    ).rejects.toBeInstanceOf(CsPlaybookNotFoundError)
    expect(tasksPort.created).toHaveLength(0)
  })

  test("createRenewal denies attaching to an account the caller cannot see", async () => {
    const workspaceId = "ws_shared_2"
    const memberACtx = makeServiceContext({ session: makeSession({ role: "member", workspaceId }) })
    const memberBCtx = makeServiceContext({ session: makeSession({ role: "member", workspaceId }) })
    const accountB = await service.createAccount(memberBCtx, {
      companyId: "company_b",
      ownerId: memberBCtx.actorId,
    })
    await expect(
      service.createRenewal(memberACtx, { accountId: accountB.id, renewalDate: "2026-12-01" }),
    ).rejects.toBeInstanceOf(CsAccountNotFoundError)
  })

  test("createRenewal succeeds for an account the caller can see", async () => {
    const ctx = makeServiceContext({ session: makeSession({ role: "member" }) })
    const account = await service.createAccount(ctx, {
      companyId: "company_1",
      ownerId: ctx.actorId,
    })
    const renewal = await expectAllowed(() =>
      service.createRenewal(ctx, { accountId: account.id, renewalDate: "2026-12-01" }),
    )
    expect(renewal.accountId).toBe(account.id)
    const listed = await service.listRenewals(ctx, {})
    expect(listed.data.map((r) => r.id)).toEqual([renewal.id])
  })
})
