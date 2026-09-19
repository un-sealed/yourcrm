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
  createProductsService,
  type ProductPriceRecord,
  type ProductRecord,
  type ProductsService,
} from "./index"
import type { ProductAuditInput, ProductListQuery } from "./types"

type StoredProduct = BaseRecord & {
  sku: string
  name: string
  description: string | null
  ownerId: string | null
  isActive: boolean
}

type StoredPrice = {
  id: string
  productId: string
  currency: string
  unitAmount: number
}

function asRecord(row: StoredProduct): ProductRecord {
  return row as unknown as ProductRecord
}

function asPrice(row: StoredPrice): ProductPriceRecord {
  return row as unknown as ProductPriceRecord
}

/** Hermetic ProductsStore port backed by the shared in-memory store. */
function makeStore() {
  const products = createStore<StoredProduct>()
  const prices: StoredPrice[] = []
  return {
    products,
    prices,
    store: {
      list: async (workspaceId: string, query: ProductListQuery) => {
        let rows = products.list(workspaceId)
        if (query.isActive !== undefined) rows = rows.filter((r) => r.isActive === query.isActive)
        if (query.query) {
          const q = query.query.toLowerCase()
          rows = rows.filter((r) =>
            `${r.sku} ${r.name} ${r.description ?? ""}`.toLowerCase().includes(q),
          )
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
        const row = products.get(id, workspaceId)
        return row ? asRecord(row) : null
      },
      findWithPrices: async (workspaceId: string, id: string) => {
        const row = products.get(id, workspaceId)
        if (!row) return null
        return {
          product: asRecord(row),
          prices: prices.filter((p) => p.productId === id).map(asPrice),
        }
      },
      create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
        const record: StoredProduct = {
          ...makeBaseRecord({ workspaceId }),
          sku: input.sku as string,
          name: input.name as string,
          description: (input.description as string | null) ?? null,
          ownerId: (input.ownerId as string | null) ?? null,
          isActive: (input.isActive as boolean | undefined) ?? true,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }
        const inserted = products.insert(record)
        for (const item of (input.prices as { currency: string; unitAmount: number }[]) ?? []) {
          prices.push({
            id: `${inserted.id}-${item.currency}`,
            productId: inserted.id,
            currency: item.currency,
            unitAmount: item.unitAmount,
          })
        }
        return asRecord(inserted)
      },
      update: async (
        workspaceId: string,
        id: string,
        input: Record<string, unknown>,
        _actorId?: string,
      ) => {
        const fields = { ...input }
        delete fields.prices
        const row = products.update(id, workspaceId, fields as Partial<StoredProduct>)
        return row ? asRecord(row) : null
      },
      replacePrices: async (
        _workspaceId: string,
        id: string,
        next: { currency: string; unitAmount: number }[],
        _actorId?: string,
      ) => {
        for (let i = prices.length - 1; i >= 0; i -= 1) {
          if (prices[i]?.productId === id) prices.splice(i, 1)
        }
        const inserted = next.map((item, index) =>
          asPrice({
            id: `${id}-${item.currency}-${index}`,
            productId: id,
            currency: item.currency,
            unitAmount: item.unitAmount,
          }),
        )
        for (const row of inserted) {
          prices.push(row as unknown as StoredPrice)
        }
        return inserted
      },
      softDelete: async (workspaceId: string, id: string) => {
        products.remove(id, workspaceId)
      },
      restore: async (workspaceId: string, id: string) => {
        products.restore(id, workspaceId)
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
  const audits: ProductAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createProductsService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seed(service: ProductsService, ctx: ServiceContext, name = "Widget") {
  return service.create(ctx, { sku: "SKU-001", name })
}

describe("products/service", () => {
  test("create validates, emits product.created and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const product = await expectAllowed(() =>
        service.create(ctx, {
          sku: "SKU-001",
          name: "Widget",
          prices: [{ currency: "USD", unitAmount: 19.99 }],
        }),
      )
      expect(product.sku).toBe("SKU-001")
      events.expectEmitted("product.created", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "product",
        entityId: product.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "product",
        recordId: product.id,
      })
      expect(audits[0]?.after).toMatchObject({ sku: "SKU-001", name: "Widget" })
    } finally {
      events.release()
    }
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.create(ctx, { sku: "  ", name: "Widget" })).rejects.toThrow()
    await expect(
      service.create(ctx, {
        sku: "SKU-1",
        name: "Widget",
        prices: [{ currency: "US", unitAmount: 1 }],
      }),
    ).rejects.toThrow()
  })

  test("get returns the product with prices, list paginates", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const found = await expectAllowed(() => service.get(ctx, created.id))
    expect(found.product.id).toBe(created.id)
    expect(found.prices).toEqual([])
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

  test("update emits product.updated and audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const updated = await expectAllowed(() =>
        service.update(ctx, created.id, {
          name: "Super Widget",
          prices: [{ currency: "EUR", unitAmount: 17.5 }],
        }),
      )
      expect(updated.name).toBe("Super Widget")
      const emitted = events.expectEmitted("product.updated", { entityId: created.id })
      expect(emitted.before).toMatchObject({ name: "Widget" })
      expect(emitted.after).toMatchObject({ name: "Super Widget" })
      expect(audits.at(-1)).toMatchObject({ action: "update", recordId: created.id })
    } finally {
      events.release()
    }
  })

  test("softDelete emits product.archived and hides the row; restore revives it", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      await expectAllowed(() => service.softDelete(ctx, created.id))
      events.expectEmitted("product.archived", { entityId: created.id })
      await expect(service.get(ctx, created.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
      const restored = await expectAllowed(() => service.restore(ctx, created.id))
      expect(restored.id).toBe(created.id)
      await expectAllowed(() => service.get(ctx, created.id))
    } finally {
      events.release()
    }
  })

  describe("denials", () => {
    let backing: ReturnType<typeof makeStore>
    let workspaceId: string
    let productId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      productId = (await seed(owner.service, owner.ctx)).id
    })

    test("viewer cannot create", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.create(ctx, { sku: "SKU-9", name: "Nope" }))
    })

    test("viewer cannot update", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.update(ctx, productId, { name: "X" }))
    })

    test("member cannot delete (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDelete(ctx, productId))
    })

    test("viewer can still list and get (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectAllowed(() => service.list(ctx, {}))
      await expectAllowed(() => service.get(ctx, productId))
    })
  })
})
