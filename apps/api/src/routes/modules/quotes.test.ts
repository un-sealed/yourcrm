import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createQuotesService, type QuotesService } from "@yourcrm/crm/src/quotes"
import type { QuoteRecord, QuotesStore } from "@yourcrm/crm/src/quotes"
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
import { createRoutes } from "./quotes"

type StoredQuote = BaseRecord & { number: string; status: string; notes: string | null }
type StoredItem = BaseRecord & {
  quoteId: string
  quantity: number
  unitAmountCents: number
}

function asRecord(row: StoredQuote): QuoteRecord {
  return row as unknown as QuoteRecord
}

/** Real domain service over a hermetic in-memory store. */
function makeFakeService() {
  const quotes = createStore<StoredQuote>()
  const items = createStore<StoredItem>()
  const store: QuotesStore = {
    list: async (workspaceId, query) => {
      const rows = quotes.list(workspaceId)
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
      const row = quotes.get(id, workspaceId)
      return row ? asRecord(row) : null
    },
    findWithLineItems: async (workspaceId, id) => {
      const row = quotes.get(id, workspaceId)
      if (!row) return null
      const lineItems = items
        .list(workspaceId)
        .filter((i) => i.quoteId === id)
        .map((i) => ({ ...i }) as unknown as Record<string, unknown>)
      return { quote: asRecord(row), lineItems: lineItems as never }
    },
    create: async (workspaceId, input, actorId) => {
      const created = quotes.insert({
        ...makeBaseRecord({ workspaceId }),
        number: input.number as string,
        status: (input.status as string | null) ?? "draft",
        notes: (input.notes as string | null) ?? null,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      })
      for (const raw of (input.lineItems as Record<string, unknown>[] | undefined) ?? []) {
        items.insert({
          ...makeBaseRecord({ workspaceId }),
          quoteId: created.id,
          quantity: (raw.quantity as number | undefined) ?? 1,
          unitAmountCents: (raw.unitAmountCents as number | undefined) ?? 0,
          ...raw,
        })
      }
      return asRecord(created)
    },
    update: async (workspaceId, id, input) => {
      const row = quotes.update(id, workspaceId, input as Partial<StoredQuote>)
      return row ? asRecord(row) : null
    },
    softDelete: async (workspaceId, id) => {
      quotes.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      quotes.restore(id, workspaceId)
    },
  }
  return createQuotesService({ store, audit: async () => undefined })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over an in-memory store. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: QuotesService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/quotes", createRoutes({ service }))
  return app
}

describe("api/quotes", () => {
  let session: { current: Session | null }
  let service: QuotesService
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
    const res = await api.get("/api/v1/quotes")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope", async () => {
    await service.create(ctx, { number: "Q-001" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/quotes")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get returns the quote with line items and totals; unknown id is NOT_FOUND", async () => {
    const created = await service.create(ctx, {
      number: "Q-001",
      lineItems: [{ description: "Design", quantity: 2, unitAmountCents: 1000 }],
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/quotes/${created.quote.id}`)
    expect(ok.status).toBe(200)
    const data = ok.expectSuccess().data as {
      id: string
      lineItems: unknown[]
      totals: { subtotalCents: number; grandTotalCents: number }
    }
    expect(data.id).toBe(created.quote.id)
    expect(data.lineItems).toHaveLength(1)
    expect(data.totals.subtotalCents).toBe(2000)
    expect(data.totals.grandTotalCents).toBe(2000)
    const missing = await api.get("/api/v1/quotes/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/quotes", { number: "  " })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/quotes", {
      number: "Q-001",
      lineItems: [{ description: "Design", quantity: 1, unitAmountCents: 2500 }],
    })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { number: string }).number).toBe("Q-001")
  })

  test("a client-supplied total is ignored: response totals are always server-computed", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/quotes", {
      number: "Q-TOTAL",
      // Neither field exists on the create schema: it is stripped by
      // validation before the service (or the store) ever sees it.
      grandTotalCents: 999999999,
      totalCents: 999999999,
      lineItems: [{ description: "Widget", quantity: 1, unitAmountCents: 1500 }],
    })
    expect(res.status).toBe(201)
    const data = res.expectSuccess().data as {
      totals: { grandTotalCents: number }
      grandTotalCents?: number
      totalCents?: number
    }
    expect(data.totals.grandTotalCents).toBe(1500)
    expect(data.grandTotalCents).toBeUndefined()
    expect(data.totalCents).toBeUndefined()
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/quotes", { number: "Q-NOPE" })
    expect(res.status).toBe(403)
    const err = res.expectError("FORBIDDEN")
    expect(err.error.message).toContain("create")
  })

  test("update, delete and restore round-trip", async () => {
    const created = await service.create(ctx, { number: "Q-001" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/quotes/${created.quote.id}`, { notes: "Net 30" })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/quotes/${created.quote.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/quotes/${created.quote.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/quotes/${created.quote.id}/restore`)
    expect(restored.status).toBe(200)
    const back = await api.get(`/api/v1/quotes/${created.quote.id}`)
    expect(back.status).toBe(200)
  })

  test("send, accept and reject round-trip; invalid transitions are rejected", async () => {
    const created = await service.create(ctx, { number: "Q-001" })
    const api = createApiClient({ app: makeTestApp(session, service) })

    // Cannot accept a draft directly.
    const badAccept = await api.post(`/api/v1/quotes/${created.quote.id}/accept`)
    expect(badAccept.status).toBe(409)
    badAccept.expectError("INVALID_TRANSITION")

    const sent = await api.post(`/api/v1/quotes/${created.quote.id}/send`)
    expect(sent.status).toBe(200)
    expect((sent.expectSuccess().data as { status: string }).status).toBe("sent")

    // Cannot send twice.
    const badSend = await api.post(`/api/v1/quotes/${created.quote.id}/send`)
    expect(badSend.status).toBe(409)
    badSend.expectError("INVALID_TRANSITION")

    const accepted = await api.post(`/api/v1/quotes/${created.quote.id}/accept`)
    expect(accepted.status).toBe(200)
    expect((accepted.expectSuccess().data as { status: string }).status).toBe("accepted")

    // Terminal state: cannot reject after accepted.
    const badReject = await api.post(`/api/v1/quotes/${created.quote.id}/reject`)
    expect(badReject.status).toBe(409)
    badReject.expectError("INVALID_TRANSITION")
  })
})
