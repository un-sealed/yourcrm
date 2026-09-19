import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createCustomerSuccessService,
  type CustomerSuccessService,
  type CustomerSuccessStore,
  type PlaybookTaskInput,
  type PlaybookTaskRecord,
  type TasksPort,
} from "@yourcrm/crm/src/customer-success"
import { createApiClient, createStore, makeBaseRecord, makeSession } from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./customer-success"

type StoredAccount = BaseRecord & {
  companyId: string
  ownerId: string | null
  lifecycleStage: string
}

/** Minimal hermetic store: enough surface for the HTTP-layer contract. */
function makeFakeStore() {
  const accounts = createStore<StoredAccount>()

  const store: CustomerSuccessStore = {
    listAccounts: async (workspaceId, query) => {
      const rows = accounts.list(workspaceId)
      const limit = query.limit ?? 25
      const data = rows.slice(0, limit)
      return {
        data,
        pagination: { nextCursor: null, limit },
      } as unknown as Awaited<ReturnType<CustomerSuccessStore["listAccounts"]>>
    },
    findAccountById: async (workspaceId, id) => {
      const row = accounts.get(id, workspaceId)
      return row
        ? (row as unknown as Awaited<ReturnType<CustomerSuccessStore["findAccountById"]>>)
        : null
    },
    createAccount: async (workspaceId, input, actorId) => {
      const row = accounts.insert({
        ...makeBaseRecord({ workspaceId }),
        companyId: input.companyId as string,
        ownerId: (input.ownerId as string | null) ?? null,
        lifecycleStage: (input.lifecycleStage as string | null) ?? "onboarding",
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      })
      return row as unknown as Awaited<ReturnType<CustomerSuccessStore["createAccount"]>>
    },
    updateAccount: async (workspaceId, id, input) => {
      const row = accounts.update(id, workspaceId, input as Partial<StoredAccount>)
      return row
        ? (row as unknown as Awaited<ReturnType<CustomerSuccessStore["updateAccount"]>>)
        : null
    },
    softDeleteAccount: async (workspaceId, id) => {
      accounts.remove(id, workspaceId)
    },
    restoreAccount: async (workspaceId, id) => {
      accounts.restore(id, workspaceId)
    },
    computeHealthFactors: async () => ({
      score: 70,
      factors: [
        {
          key: "last_activity_recency",
          label: "Recency",
          rawValue: 10,
          normalizedScore: 70,
          weight: 1,
          contribution: 70,
        },
      ],
    }),
    recordHealthScore: async (workspaceId, accountId, computation) =>
      ({
        ...makeBaseRecord({ workspaceId }),
        accountId,
        score: computation.score.toFixed(2),
        factors: computation.factors,
        computedAt: new Date().toISOString(),
        computedBy: null,
      }) as unknown as Awaited<ReturnType<CustomerSuccessStore["recordHealthScore"]>>,
    listHealthScores: async () => [],
    listRenewals: async () => ({ data: [], pagination: { nextCursor: null, limit: 25 } }),
    findRenewalById: async () => null,
    createRenewal: async (workspaceId, input) =>
      ({
        ...makeBaseRecord({ workspaceId }),
        accountId: input.accountId as string,
        renewalDate: input.renewalDate as string,
        arr: null,
        ownerId: null,
        status: "open",
        riskFlag: false,
        notes: null,
      }) as unknown as Awaited<ReturnType<CustomerSuccessStore["createRenewal"]>>,
    updateRenewal: async () => null,
    describePlaybooks: () => [
      { key: "onboarding", label: "Onboarding", description: "", taskCount: 1 },
    ],
    getPlaybook: (key) =>
      key === "onboarding"
        ? {
            key: "onboarding",
            label: "Onboarding",
            description: "",
            tasks: [{ title: "Kickoff call", dueOffsetDays: 3, priority: "high" }],
          }
        : null,
    recordPlaybookApplication: async (workspaceId, accountId, playbookKey, taskId) =>
      ({
        ...makeBaseRecord({ workspaceId }),
        accountId,
        playbookKey,
        taskId,
        appliedBy: null,
      }) as unknown as Awaited<ReturnType<CustomerSuccessStore["recordPlaybookApplication"]>>,
    listPlaybookTasks: async () => [],
  }
  return store
}

function makeFakeTasksPort(): TasksPort {
  const tasks = createStore<BaseRecord & { title: string }>()
  return {
    createTask: async (ctx, input: PlaybookTaskInput) => {
      const row = tasks.insert({
        ...makeBaseRecord({ workspaceId: ctx.workspaceId }),
        title: input.title,
      })
      return row as unknown as PlaybookTaskRecord
    },
    getTasks: async () => [],
  }
}

function makeFakeService(): CustomerSuccessService {
  return createCustomerSuccessService({
    store: makeFakeStore(),
    tasks: makeFakeTasksPort(),
    audit: async () => undefined,
  })
}

/** Hermetic API test: the route factory takes a service — see people.test.ts. */
function makeTestApp(session: { current: Session | null }, service: CustomerSuccessService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/customer-success", createRoutes({ service }))
  return app
}

describe("api/customer-success", () => {
  let session: { current: Session | null }
  let service: CustomerSuccessService

  beforeEach(() => {
    const owner = makeSession({ role: "owner" })
    session = { current: owner }
    service = makeFakeService()
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/customer-success/accounts")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/customer-success/accounts", {})
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/customer-success/accounts", { companyId: "company_1" })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { companyId: string }).companyId).toBe("company_1")
  })

  test("get returns the account; unknown id is NOT_FOUND", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const created = await api.post("/api/v1/customer-success/accounts", { companyId: "company_1" })
    const id = (created.expectSuccess().data as { id: string }).id
    const ok = await api.get(`/api/v1/customer-success/accounts/${id}`)
    expect(ok.status).toBe(200)
    const missing = await api.get("/api/v1/customer-success/accounts/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/customer-success/accounts", { companyId: "company_1" })
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
  })

  test("health-score recompute stores and returns a score with factors", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const created = await api.post("/api/v1/customer-success/accounts", { companyId: "company_1" })
    const id = (created.expectSuccess().data as { id: string }).id
    const res = await api.post(`/api/v1/customer-success/accounts/${id}/health-scores`)
    expect(res.status).toBe(201)
    const body = res.expectSuccess().data as { score: string; factors: unknown[] }
    expect(Number(body.score)).toBe(70)
    expect(body.factors).toHaveLength(1)
  })

  test("playbook catalogue and apply create tasks", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const catalogue = await api.get("/api/v1/customer-success/playbooks")
    expect(catalogue.status).toBe(200)
    expect(catalogue.expectSuccess().data).toHaveLength(1)

    const created = await api.post("/api/v1/customer-success/accounts", { companyId: "company_1" })
    const id = (created.expectSuccess().data as { id: string }).id
    const applied = await api.post(`/api/v1/customer-success/accounts/${id}/playbooks/apply`, {
      playbookKey: "onboarding",
    })
    expect(applied.status).toBe(201)
    expect(applied.expectSuccess().data).toHaveLength(1)

    const bad = await api.post(`/api/v1/customer-success/accounts/${id}/playbooks/apply`, {
      playbookKey: "not-real",
    })
    expect(bad.status).toBe(400)
  })

  test("renewals: create validates and lists", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const created = await api.post("/api/v1/customer-success/accounts", { companyId: "company_1" })
    const id = (created.expectSuccess().data as { id: string }).id
    const bad = await api.post("/api/v1/customer-success/renewals", { accountId: id })
    expect(bad.status).toBe(400)
    const good = await api.post("/api/v1/customer-success/renewals", {
      accountId: id,
      renewalDate: "2026-12-01",
    })
    expect(good.status).toBe(201)
  })
})
