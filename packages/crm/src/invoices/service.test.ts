import { beforeEach, describe, expect, test } from "bun:test"
import type { ServiceContext } from "../index"
import {
  captureEvents,
  createStore,
  expectAllowed,
  expectDenied,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import {
  computeTotals,
  createInvoicesService,
  type InvoiceLineItemRecord,
  type InvoiceRecord,
  type InvoicesService,
  type PaymentRecord,
} from "./index"
import type { InvoiceAuditInput, InvoiceListQuery } from "./types"

type StoredInvoice = BaseRecord & {
  number: string
  status: string
  currency: string
  issueDate: string | null
  dueDate: string | null
  companyId: string | null
  personId: string | null
  quoteId: string | null
  ownerId: string | null
  notes: string | null
}

type StoredLineItem = BaseRecord & {
  invoiceId: string
  description: string
  quantity: number
  unitAmountCents: number
  position: number
}

type StoredPayment = BaseRecord & {
  invoiceId: string
  amountCents: number
  currency: string
  method: string
}

function asInvoice(row: StoredInvoice): InvoiceRecord {
  return row as unknown as InvoiceRecord
}

function asItem(row: StoredLineItem): InvoiceLineItemRecord {
  return row as unknown as InvoiceLineItemRecord
}

function asPayment(row: StoredPayment): PaymentRecord {
  return row as unknown as PaymentRecord
}

/** Hermetic InvoicesStore port backed by the shared in-memory stores. */
function makeStore() {
  const invoices = createStore<StoredInvoice>()
  const items = createStore<StoredLineItem>()
  const payments = createStore<StoredPayment>()
  return {
    invoices,
    items,
    payments,
    store: {
      list: async (workspaceId: string, query: InvoiceListQuery) => {
        let rows = invoices.list(workspaceId)
        if (query.status) rows = rows.filter((r) => r.status === query.status)
        if (query.query) {
          const q = query.query.toLowerCase()
          rows = rows.filter(
            (r) =>
              r.number.toLowerCase().includes(q) || (r.notes ?? "").toLowerCase().includes(q),
          )
        }
        const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
        const data = rows.slice(0, limit)
        return {
          data: data.map(asInvoice),
          pagination: {
            nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
            limit,
          },
        }
      },
      findById: async (workspaceId: string, id: string) => {
        const row = invoices.get(id, workspaceId)
        return row ? asInvoice(row) : null
      },
      findWithDetails: async (workspaceId: string, id: string) => {
        const row = invoices.get(id, workspaceId)
        if (!row) return null
        return {
          invoice: asInvoice(row),
          lineItems: items.list(workspaceId).filter((i) => i.invoiceId === id).map(asItem),
          payments: payments.list(workspaceId).filter((p) => p.invoiceId === id).map(asPayment),
        }
      },
      create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
        const record: StoredInvoice = {
          ...makeBaseRecord({ workspaceId }),
          number: input.number as string,
          status: (input.status as string | null) ?? "draft",
          currency: (input.currency as string | null) ?? "USD",
          issueDate: (input.issueDate as string | null) ?? null,
          dueDate: (input.dueDate as string | null) ?? null,
          companyId: (input.companyId as string | null) ?? null,
          personId: (input.personId as string | null) ?? null,
          quoteId: (input.quoteId as string | null) ?? null,
          ownerId: (input.ownerId as string | null) ?? null,
          notes: (input.notes as string | null) ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }
        const created = invoices.insert(record)
        let position = 0
        for (const raw of (input.lineItems as Record<string, unknown>[] | undefined) ?? []) {
          items.insert({
            ...makeBaseRecord({ workspaceId }),
            invoiceId: created.id,
            description: raw.description as string,
            quantity: (raw.quantity as number | undefined) ?? 1,
            unitAmountCents: (raw.unitAmountCents as number | undefined) ?? 0,
            position: position++,
          })
        }
        return asInvoice(created)
      },
      update: async (
        workspaceId: string,
        id: string,
        input: Record<string, unknown>,
        _actorId?: string,
      ) => {
        const row = invoices.update(id, workspaceId, input as Partial<StoredInvoice>)
        return row ? asInvoice(row) : null
      },
      recordPayment: async (
        workspaceId: string,
        invoiceId: string,
        input: Record<string, unknown>,
        actorId?: string,
      ) => {
        const record: StoredPayment = {
          ...makeBaseRecord({ workspaceId }),
          invoiceId,
          amountCents: input.amountCents as number,
          currency: (input.currency as string | null) ?? "USD",
          method: (input.method as string | undefined) ?? "other",
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }
        return asPayment(payments.insert(record))
      },
      softDelete: async (workspaceId: string, id: string) => {
        invoices.remove(id, workspaceId)
      },
      restore: async (workspaceId: string, id: string) => {
        invoices.restore(id, workspaceId)
      },
    },
  }
}

function setup(
  role: "owner" | "admin" | "member" | "viewer" = "owner",
  shared?: ReturnType<typeof makeStore>,
  workspaceId?: string,
) {
  const session = makeSession({ role, ...(workspaceId === undefined ? {} : { workspaceId }) })
  const ctx = makeServiceContext({ session })
  const audits: InvoiceAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createInvoicesService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seed(service: InvoicesService, ctx: ServiceContext, number = "INV-001") {
  return service.create(ctx, {
    number,
    lineItems: [{ description: "Design work", quantity: 2, unitAmountCents: 5000 }],
  })
}

describe("invoices/service", () => {
  test("create validates, emits invoice.created and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const created = await expectAllowed(() => seed(service, ctx))
      expect((created.invoice.number as string) ?? created.invoice.number).toBe("INV-001")
      expect(created.totals.totalCents).toBe(10000)
      expect(created.totals.balanceDueCents).toBe(10000)
      events.expectEmitted("invoice.created", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "invoice",
        entityId: created.invoice.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "invoice",
        recordId: created.invoice.id,
      })
      expect(audits[0]?.after).toMatchObject({ number: "INV-001" })
    } finally {
      events.release()
    }
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.create(ctx, { number: "  " })).rejects.toThrow()
    await expect(
      service.create(ctx, { number: "INV-002", lineItems: [{ description: "", quantity: 1 }] }),
    ).rejects.toThrow()
  })

  test("get returns the invoice with line items, payments and derived totals", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const found = await expectAllowed(() => service.get(ctx, created.invoice.id))
    expect(found.invoice.id).toBe(created.invoice.id)
    expect(found.lineItems).toHaveLength(1)
    expect(found.payments).toEqual([])
    expect(found.totals).toMatchObject({ totalCents: 10000, paidCents: 0, balanceDueCents: 10000 })
    const listed = await expectAllowed(() => service.list(ctx, { limit: 25 }))
    expect(listed.data).toHaveLength(1)
    expect(listed.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get throws NOT_FOUND for unknown ids", async () => {
    const { ctx, service } = setup()
    const err = await service.get(ctx, "missing").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe("NOT_FOUND")
  })

  test("update emits invoice.updated and audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const updated = await expectAllowed(() =>
        service.update(ctx, created.invoice.id, { notes: "Net 30" }),
      )
      expect(updated.notes).toBe("Net 30")
      const emitted = events.expectEmitted("invoice.updated", { entityId: created.invoice.id })
      expect(emitted.before).toMatchObject({ notes: null })
      expect(emitted.after).toMatchObject({ notes: "Net 30" })
      expect(audits.at(-1)).toMatchObject({ action: "update", recordId: created.invoice.id })
    } finally {
      events.release()
    }
  })

  test("softDelete emits invoice.updated and hides the row; restore revives it", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      await expectAllowed(() => service.softDelete(ctx, created.invoice.id))
      events.expectEmitted("invoice.updated", { entityId: created.invoice.id })
      await expect(service.get(ctx, created.invoice.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
      const restored = await expectAllowed(() => service.restore(ctx, created.invoice.id))
      expect(restored.id).toBe(created.invoice.id)
      await expectAllowed(() => service.get(ctx, created.invoice.id))
    } finally {
      events.release()
    }
  })

  test("send moves draft to sent and emits invoice.sent", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const sent = await expectAllowed(() => service.send(ctx, created.invoice.id))
      expect(sent.status).toBe("sent")
      events.expectEmitted("invoice.sent", { entityId: created.invoice.id })
      await expect(service.send(ctx, created.invoice.id)).rejects.toThrow("only draft")
    } finally {
      events.release()
    }
  })

  test("recordPayment derives the balance and auto-marks paid with invoice.paid", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const partial = await expectAllowed(() =>
        service.recordPayment(ctx, created.invoice.id, { amountCents: 4000 }),
      )
      expect(partial.payments).toHaveLength(1)
      expect(partial.totals).toMatchObject({
        totalCents: 10000,
        paidCents: 4000,
        balanceDueCents: 6000,
      })
      expect(partial.invoice.status).toBe("draft")
      events.expectEmitted("payment.recorded", { entityType: "payment" })
      const full = await expectAllowed(() =>
        service.recordPayment(ctx, created.invoice.id, { amountCents: 6000 }),
      )
      expect(full.totals.balanceDueCents).toBe(0)
      expect(full.invoice.status).toBe("paid")
      events.expectEmitted("invoice.paid", { entityId: created.invoice.id })
    } finally {
      events.release()
    }
  })

  test("overdue is derived from the due date, never stored", async () => {
    const { ctx, service } = setup()
    const created = await service.create(ctx, {
      number: "INV-OLD",
      dueDate: "2000-01-01",
      lineItems: [{ description: "Work", quantity: 1, unitAmountCents: 100 }],
    })
    expect(created.totals.overdue).toBe(true)
    expect(created.invoice.status).toBe("draft")
    const totals = computeTotals([], [], { status: "paid", dueDate: "2000-01-01" })
    expect(totals.overdue).toBe(false)
  })

  describe("denials", () => {
    let backing: ReturnType<typeof makeStore>
    let workspaceId: string
    let invoiceId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      invoiceId = (await seed(owner.service, owner.ctx)).invoice.id
    })

    test("viewer cannot create", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.create(ctx, { number: "INV-NOPE" }))
    })

    test("viewer cannot update", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.update(ctx, invoiceId, { notes: "X" }))
    })

    test("viewer cannot record a payment", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.recordPayment(ctx, invoiceId, { amountCents: 100 }))
    })

    test("member cannot delete (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDelete(ctx, invoiceId))
    })

    test("viewer can still list and get (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectAllowed(() => service.list(ctx, {}))
      await expectAllowed(() => service.get(ctx, invoiceId))
    })
  })
})
