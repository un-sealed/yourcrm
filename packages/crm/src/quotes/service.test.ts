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
  computeQuoteTotals,
  createQuotesService,
  InvalidQuoteTransitionError,
  type QuoteLineItemRecord,
  type QuotesService,
  type QuoteRecord,
} from "./index"
import type { QuoteAuditInput, QuoteListQuery } from "./types"

type StoredQuote = BaseRecord & {
  number: string
  status: string
  currency: string
  discountType: string
  discountValue: number
  taxRateBps: number
  notes: string | null
}

type StoredLineItem = BaseRecord & {
  quoteId: string
  description: string
  quantity: number
  unitAmountCents: number
  position: number
}

function asRecord(row: StoredQuote): QuoteRecord {
  return row as unknown as QuoteRecord
}

function asLineItem(row: StoredLineItem): QuoteLineItemRecord {
  return row as unknown as QuoteLineItemRecord
}

/** Hermetic QuotesStore port backed by the shared in-memory store. */
function makeStore() {
  const quotes = createStore<StoredQuote>()
  const lineItems = createStore<StoredLineItem>()
  return {
    quotes,
    lineItems,
    store: {
      list: async (workspaceId: string, query: QuoteListQuery) => {
        let rows = quotes.list(workspaceId)
        if (query.status) rows = rows.filter((r) => r.status === query.status)
        if (query.query) {
          const q = query.query.toLowerCase()
          rows = rows.filter((r) => r.number.toLowerCase().includes(q))
        }
        const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
        const data = rows.slice(0, limit)
        return {
          data: data.map(asRecord),
          pagination: {
            nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
            limit,
          },
        }
      },
      findById: async (workspaceId: string, id: string) => {
        const row = quotes.get(id, workspaceId)
        return row ? asRecord(row) : null
      },
      findWithLineItems: async (workspaceId: string, id: string) => {
        const row = quotes.get(id, workspaceId)
        if (!row) return null
        return {
          quote: asRecord(row),
          lineItems: lineItems
            .list(workspaceId)
            .filter((i) => i.quoteId === id)
            .map(asLineItem),
        }
      },
      create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
        const record: StoredQuote = {
          ...makeBaseRecord({ workspaceId }),
          number: input.number as string,
          status: (input.status as string | null) ?? "draft",
          currency: (input.currency as string | null) ?? "USD",
          discountType: (input.discountType as string | null) ?? "none",
          discountValue: (input.discountValue as number | null) ?? 0,
          taxRateBps: (input.taxRateBps as number | null) ?? 0,
          notes: (input.notes as string | null) ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }
        const created = quotes.insert(record)
        const rawItems = (input.lineItems as Record<string, unknown>[] | undefined) ?? []
        rawItems.forEach((item, index) => {
          lineItems.insert({
            ...makeBaseRecord({ workspaceId }),
            quoteId: created.id,
            description: item.description as string,
            quantity: (item.quantity as number | undefined) ?? 1,
            unitAmountCents: (item.unitAmountCents as number | undefined) ?? 0,
            position: (item.position as number | undefined) ?? index,
          })
        })
        return asRecord(created)
      },
      update: async (
        workspaceId: string,
        id: string,
        input: Record<string, unknown>,
        _actorId?: string,
      ) => {
        const row = quotes.update(id, workspaceId, input as Partial<StoredQuote>)
        return row ? asRecord(row) : null
      },
      softDelete: async (workspaceId: string, id: string) => {
        quotes.remove(id, workspaceId)
      },
      restore: async (workspaceId: string, id: string) => {
        quotes.restore(id, workspaceId)
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
  const audits: QuoteAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createQuotesService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seed(service: QuotesService, ctx: ServiceContext, number = "Q-001") {
  return service.create(ctx, { number })
}

describe("quotes/computeQuoteTotals", () => {
  test("subtotal is the sum of quantity × unitAmountCents", () => {
    const totals = computeQuoteTotals(
      [
        { quantity: 2, unitAmountCents: 1000 },
        { quantity: 1, unitAmountCents: 500 },
      ],
      { discountType: "none", discountValue: 0, taxRateBps: 0 },
    )
    expect(totals).toEqual({
      subtotalCents: 2500,
      discountCents: 0,
      taxCents: 0,
      grandTotalCents: 2500,
    })
  })

  test("percent discount then tax on the post-discount amount", () => {
    // subtotal 2500, 10% discount (250), taxable 2250, 8% tax (180) -> 2430
    const totals = computeQuoteTotals([{ quantity: 1, unitAmountCents: 2500 }], {
      discountType: "percent",
      discountValue: 1000,
      taxRateBps: 800,
    })
    expect(totals).toEqual({
      subtotalCents: 2500,
      discountCents: 250,
      taxCents: 180,
      grandTotalCents: 2430,
    })
  })

  test("fixed discount is capped at the subtotal (never negative)", () => {
    const totals = computeQuoteTotals([{ quantity: 1, unitAmountCents: 500 }], {
      discountType: "fixed",
      discountValue: 9999,
      taxRateBps: 0,
    })
    expect(totals.discountCents).toBe(500)
    expect(totals.grandTotalCents).toBe(0)
  })
})

describe("quotes/service", () => {
  test("create validates, emits quote.created and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const created = await expectAllowed(() =>
        service.create(ctx, {
          number: "Q-001",
          lineItems: [{ description: "Consulting", quantity: 2, unitAmountCents: 5000 }],
        }),
      )
      expect(created.quote.number).toBe("Q-001")
      expect(created.totals.subtotalCents).toBe(10000)
      events.expectEmitted("quote.created", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "quote",
        entityId: created.quote.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "quote",
        recordId: created.quote.id,
      })
    } finally {
      events.release()
    }
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.create(ctx, { number: "  " })).rejects.toThrow()
  })

  test("a client-supplied grand total is ignored: the server always recomputes it", async () => {
    const { ctx, service } = setup()
    const created = await expectAllowed(() =>
      service.create(ctx, {
        number: "Q-001",
        // Not a field on the schema: parse() strips it before it reaches the
        // store, so the domain totals are the only source of truth.
        grandTotalCents: 999999999,
        totalCents: 999999999,
        lineItems: [{ description: "Widget", quantity: 1, unitAmountCents: 1000 }],
      } as unknown as Record<string, unknown>),
    )
    expect(created.totals.grandTotalCents).toBe(1000)
    expect((created.quote as Record<string, unknown>).grandTotalCents).toBeUndefined()
    expect((created.quote as Record<string, unknown>).totalCents).toBeUndefined()

    // Same guarantee on update: a supplied total is dropped by the schema.
    const updated = await expectAllowed(() =>
      service.update(ctx, created.quote.id, {
        notes: "revised",
        grandTotalCents: 1,
      } as unknown as Record<string, unknown>),
    )
    expect((updated as Record<string, unknown>).grandTotalCents).toBeUndefined()
    const reGet = await expectAllowed(() => service.get(ctx, created.quote.id))
    expect(reGet.totals.grandTotalCents).toBe(1000)
  })

  test("get returns the quote with totals, list paginates", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const found = await expectAllowed(() => service.get(ctx, created.quote.id))
    expect(found.quote.id).toBe(created.quote.id)
    expect(found.lineItems).toEqual([])
    expect(found.totals.grandTotalCents).toBe(0)
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

  test("update emits quote.updated and audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const updated = await expectAllowed(() =>
        service.update(ctx, created.quote.id, { notes: "Net 30" }),
      )
      expect(updated.notes).toBe("Net 30")
      const emitted = events.expectEmitted("quote.updated", { entityId: created.quote.id })
      expect(emitted.after).toMatchObject({ notes: "Net 30" })
      expect(audits.at(-1)).toMatchObject({ action: "update", recordId: created.quote.id })
    } finally {
      events.release()
    }
  })

  test("softDelete emits quote.updated and hides the row; restore revives it", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      await expectAllowed(() => service.softDelete(ctx, created.quote.id))
      events.expectEmitted("quote.updated", { entityId: created.quote.id })
      await expect(service.get(ctx, created.quote.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
      const restored = await expectAllowed(() => service.restore(ctx, created.quote.id))
      expect(restored.id).toBe(created.quote.id)
      await expectAllowed(() => service.get(ctx, created.quote.id))
    } finally {
      events.release()
    }
  })

  describe("status lifecycle", () => {
    test("draft -> sent -> accepted emits the right events in order", async () => {
      const { ctx, service } = setup()
      const created = await seed(service, ctx)
      const events = captureEvents()
      try {
        const sent = await expectAllowed(() => service.send(ctx, created.quote.id))
        expect(sent.status).toBe("sent")
        events.expectEmitted("quote.sent", { entityId: created.quote.id })

        const accepted = await expectAllowed(() => service.accept(ctx, created.quote.id))
        expect(accepted.status).toBe("accepted")
        events.expectEmitted("quote.accepted", { entityId: created.quote.id })
      } finally {
        events.release()
      }
    })

    test("draft -> sent -> rejected is a valid path", async () => {
      const { ctx, service } = setup()
      const created = await seed(service, ctx)
      const events = captureEvents()
      try {
        await expectAllowed(() => service.send(ctx, created.quote.id))
        const rejected = await expectAllowed(() => service.reject(ctx, created.quote.id))
        expect(rejected.status).toBe("rejected")
        events.expectEmitted("quote.rejected", { entityId: created.quote.id })
      } finally {
        events.release()
      }
    })

    test("cannot accept a draft quote directly (must be sent first)", async () => {
      const { ctx, service } = setup()
      const created = await seed(service, ctx)
      const err = await service.accept(ctx, created.quote.id).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(InvalidQuoteTransitionError)
      expect((err as Error).message).toMatch(/draft.*accepted/)
    })

    test("cannot send an already-sent quote", async () => {
      const { ctx, service } = setup()
      const created = await seed(service, ctx)
      await expectAllowed(() => service.send(ctx, created.quote.id))
      const err = await service.send(ctx, created.quote.id).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(InvalidQuoteTransitionError)
    })

    test("cannot transition out of a terminal accepted/rejected state", async () => {
      const { ctx, service } = setup()
      const created = await seed(service, ctx)
      await expectAllowed(() => service.send(ctx, created.quote.id))
      await expectAllowed(() => service.accept(ctx, created.quote.id))
      const err = await service.reject(ctx, created.quote.id).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(InvalidQuoteTransitionError)
    })
  })

  describe("denials", () => {
    let backing: ReturnType<typeof makeStore>
    let workspaceId: string
    let quoteId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      quoteId = (await seed(owner.service, owner.ctx)).quote.id
    })

    test("viewer cannot create", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.create(ctx, { number: "Nope" }))
    })

    test("viewer cannot update", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.update(ctx, quoteId, { notes: "X" }))
    })

    test("viewer cannot send", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.send(ctx, quoteId))
    })

    test("member cannot delete (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDelete(ctx, quoteId))
    })

    test("viewer can still list and get (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectAllowed(() => service.list(ctx, {}))
      await expectAllowed(() => service.get(ctx, quoteId))
    })
  })
})
