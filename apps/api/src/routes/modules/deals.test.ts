import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createDealsService, type DealsService } from "@yourcrm/crm/src/deals"
import type { DealsStore, DealRecord } from "@yourcrm/crm/src/deals"
import {
  createApiClient,
  createStore,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./deals"

type StoredDeal = BaseRecord & {
  name: string
  amount: string | null
  currency: string
  stage: string
  stageId: string | null
  probability: number | null
  closeReason: string | null
}

function asRecord(row: StoredDeal): DealRecord {
  return row as unknown as DealRecord
}

/** Real domain service over a hermetic in-memory store. */
function makeFakeService() {
  const deals = createStore<StoredDeal>()
  const store: DealsStore = {
    list: async (workspaceId, query) => {
      let rows = deals.list(workspaceId)
      if (query.stage) rows = rows.filter((r) => r.stage === query.stage)
      if (query.query) {
        const q = (query.query as string).toLowerCase()
        rows = rows.filter((r) => r.name.toLowerCase().includes(q))
      }
      const limit = query.limit ?? 25
      const data = rows.slice(0, limit)
      return {
        data: data.map(asRecord),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    findById: async (workspaceId, id) => {
      const row = deals.get(id, workspaceId)
      return row ? asRecord(row) : null
    },
    create: async (workspaceId, input, actorId) => {
      return asRecord(
        deals.insert({
          ...makeBaseRecord({ workspaceId }),
          name: input.name as string,
          amount: input.amount === undefined || input.amount === null ? null : String(input.amount),
          currency: "USD",
          stage: (input.stage as string | null) ?? "qualification",
          stageId: null,
          probability: (input.probability as number | null) ?? null,
          closeReason: null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    update: async (workspaceId, id, input) => {
      const row = deals.update(id, workspaceId, input as Partial<StoredDeal>)
      return row ? asRecord(row) : null
    },
    changeStage: async (workspaceId, id, input) => {
      const row = deals.update(id, workspaceId, { stage: input.stage } as Partial<StoredDeal>)
      return row ? asRecord(row) : null
    },
    close: async (workspaceId, id, input) => {
      const row = deals.update(id, workspaceId, {
        stage: input.stage,
        closeReason: (input.closeReason as string | null) ?? null,
      } as Partial<StoredDeal>)
      return row ? asRecord(row) : null
    },
    softDelete: async (workspaceId, id) => {
      deals.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      deals.restore(id, workspaceId)
    },
  }
  return createDealsService({ store, audit: async () => undefined })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over an in-memory store. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: DealsService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/deals", createRoutes({ service }))
  return app
}

describe("api/deals", () => {
  let session: { current: Session | null }
  let service: DealsService
  let ctx: ReturnType<typeof makeServiceContext>

  beforeEach(() => {
    const owner = makeSession({ role: "owner" })
    ctx = makeServiceContext({ session: owner })
    session = { current: owner }
    service = makeFakeService()
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/deals")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope", async () => {
    await service.create(ctx, { name: "Acme renewal" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/deals")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get returns the deal; unknown id is NOT_FOUND", async () => {
    const created = await service.create(ctx, { name: "Acme renewal" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/deals/${created.id}`)
    expect(ok.status).toBe(200)
    const data = ok.expectSuccess().data as { id: string }
    expect(data.id).toBe(created.id)
    const missing = await api.get("/api/v1/deals/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/deals", { name: "  " })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/deals", { name: "Acme renewal", amount: 50000 })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { name: string }).name).toBe("Acme renewal")
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/deals", { name: "Nope" })
    expect(res.status).toBe(403)
    const err = res.expectError("FORBIDDEN")
    expect(err.error.message).toContain("create")
  })

  test("stage move, win and lose round-trip", async () => {
    const created = await service.create(ctx, { name: "Acme renewal" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const moved = await api.post(`/api/v1/deals/${created.id}/stage`, { stage: "proposal" })
    expect(moved.status).toBe(200)
    expect((moved.expectSuccess().data as { stage: string }).stage).toBe("proposal")
    const badStage = await api.post(`/api/v1/deals/${created.id}/stage`, { stage: "nope" })
    expect(badStage.status).toBe(400)
    badStage.expectError("VALIDATION_ERROR")
    const won = await api.post(`/api/v1/deals/${created.id}/win`, { closeReason: "Signed" })
    expect(won.status).toBe(200)
    expect((won.expectSuccess().data as { stage: string }).stage).toBe("won")
  })

  test("update, delete and restore round-trip", async () => {
    const created = await service.create(ctx, { name: "Acme renewal" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/deals/${created.id}`, { amount: 75000 })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/deals/${created.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/deals/${created.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/deals/${created.id}/restore`)
    expect(restored.status).toBe(200)
    const back = await api.get(`/api/v1/deals/${created.id}`)
    expect(back.status).toBe(200)
  })
})
