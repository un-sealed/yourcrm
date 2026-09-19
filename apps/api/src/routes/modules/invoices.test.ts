import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createInvoicesService, type InvoicesService } from "@yourcrm/crm/src/invoices"
import type { InvoiceRecord, InvoicesStore } from "@yourcrm/crm/src/invoices"
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
import { createRoutes } from "./invoices"

type StoredInvoice = BaseRecord & { number: string; status: string; notes: string | null }
type StoredItem = BaseRecord & { invoiceId: string }
type StoredPayment = BaseRecord & { invoiceId: string; amountCents: number }

function asRecord(row: StoredInvoice): InvoiceRecord {
  return row as unknown as InvoiceRecord
}

/** Real domain service over a hermetic in-memory store. */
function makeFakeService() {
  const invoices = createStore<StoredInvoice>()
  const items = createStore<StoredItem>()
  const payments = createStore<StoredPayment>()
  const store: InvoicesStore = {
    list: async (workspaceId, query) => {
      const rows = invoices.list(workspaceId)
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
      const row = invoices.get(id, workspaceId)
      return row ? asRecord(row) : null
    },
    findWithDetails: async (workspaceId, id) => {
      const row = invoices.get(id, workspaceId)
      if (!row) return null
      const lineItems = items
        .list(workspaceId)
        .filter((i) => i.invoiceId === id)
        .map((i) => ({ ...i, quantity: 1, unitAmountCents: 5000 }) as unknown as Record<string, unknown>)
      const paymentRows = payments
        .list(workspaceId)
        .filter((p) => p.invoiceId === id)
        .map((p) => ({ ...p }) as unknown as Record<string, unknown>)
      return {
        invoice: asRecord(row),
        lineItems: lineItems as never,
        payments: paymentRows as never,
      }
    },
    create: async (workspaceId, input, actorId) => {
      const created = invoices.insert({
        ...makeBaseRecord({ workspaceId }),
        number: input.number as string,
        status: (input.status as string | null) ?? "draft",
        notes: (input.notes as string | null) ?? null,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      })
      for (const raw of (input.lineItems as Record<string, unknown>[] | undefined) ?? []) {
        items.insert({ ...makeBaseRecord({ workspaceId }), invoiceId: created.id, ...raw })
      }
      return asRecord(created)
    },
    update: async (workspaceId, id, input) => {
      const row = invoices.update(id, workspaceId, input as Partial<StoredInvoice>)
      return row ? asRecord(row) : null
    },
    recordPayment: async (workspaceId, invoiceId, input, actorId) => {
      const created = payments.insert({
        ...makeBaseRecord({ workspaceId }),
        invoiceId,
        amountCents: input.amountCents as number,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      })
      return created as unknown as Record<string, unknown> as never
    },
    softDelete: async (workspaceId, id) => {
      invoices.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      invoices.restore(id, workspaceId)
    },
  }
  return createInvoicesService({ store, audit: async () => undefined })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over an in-memory store. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: InvoicesService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/invoices", createRoutes({ service }))
  return app
}

describe("api/invoices", () => {
  let session: { current: Session | null }
  let service: InvoicesService
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
    const res = await api.get("/api/v1/invoices")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope", async () => {
    await service.create(ctx, { number: "INV-001" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/invoices")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get returns the invoice with details; unknown id is NOT_FOUND", async () => {
    const created = await service.create(ctx, { number: "INV-001" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/invoices/${created.invoice.id}`)
    expect(ok.status).toBe(200)
    const data = ok.expectSuccess().data as {
      id: string
      lineItems: unknown[]
      payments: unknown[]
      totals: { totalCents: number; balanceDueCents: number }
    }
    expect(data.id).toBe(created.invoice.id)
    expect(data.lineItems).toEqual([])
    expect(data.payments).toEqual([])
    expect(data.totals.balanceDueCents).toBe(0)
    const missing = await api.get("/api/v1/invoices/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/invoices", { number: "  " })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/invoices", {
      number: "INV-001",
      lineItems: [{ description: "Design", quantity: 1, unitAmountCents: 2500 }],
    })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { number: string }).number).toBe("INV-001")
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/invoices", { number: "INV-NOPE" })
    expect(res.status).toBe(403)
    const err = res.expectError("FORBIDDEN")
    expect(err.error.message).toContain("create")
  })

  test("update, delete and restore round-trip", async () => {
    const created = await service.create(ctx, { number: "INV-001" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/invoices/${created.invoice.id}`, { notes: "Net 30" })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/invoices/${created.invoice.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/invoices/${created.invoice.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/invoices/${created.invoice.id}/restore`)
    expect(restored.status).toBe(200)
    const back = await api.get(`/api/v1/invoices/${created.invoice.id}`)
    expect(back.status).toBe(200)
  })

  test("send and recordPayment round-trip", async () => {
    const created = await service.create(ctx, { number: "INV-001" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const sent = await api.post(`/api/v1/invoices/${created.invoice.id}/send`)
    expect(sent.status).toBe(200)
    expect((sent.expectSuccess().data as { status: string }).status).toBe("sent")
    const badPayment = await api.post(`/api/v1/invoices/${created.invoice.id}/payments`, {
      amountCents: 0,
    })
    expect(badPayment.status).toBe(400)
    badPayment.expectError("VALIDATION_ERROR")
    const paid = await api.post(`/api/v1/invoices/${created.invoice.id}/payments`, {
      amountCents: 5000,
    })
    expect(paid.status).toBe(201)
    const data = paid.expectSuccess().data as { payments: unknown[] }
    expect(data.payments).toHaveLength(1)
  })
})
