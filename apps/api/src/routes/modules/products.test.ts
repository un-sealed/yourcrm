import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createProductsService, type ProductsService } from "@yourcrm/crm/src/products"
import type { ProductsStore, ProductRecord } from "@yourcrm/crm/src/products"
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
import { createRoutes } from "./products"

type StoredProduct = BaseRecord & { sku: string; name: string; isActive: boolean }

function asRecord(row: StoredProduct): ProductRecord {
  return row as unknown as ProductRecord
}

/** Real domain service over a hermetic in-memory store. */
function makeFakeService() {
  const products = createStore<StoredProduct>()
  const store: ProductsStore = {
    list: async (workspaceId, query) => {
      let rows = products.list(workspaceId)
      if (query.isActive !== undefined) rows = rows.filter((r) => r.isActive === query.isActive)
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
      const row = products.get(id, workspaceId)
      return row ? asRecord(row) : null
    },
    findWithPrices: async (workspaceId, id) => {
      const row = products.get(id, workspaceId)
      if (!row) return null
      return { product: asRecord(row), prices: [] }
    },
    create: async (workspaceId, input, actorId) => {
      return asRecord(
        products.insert({
          ...makeBaseRecord({ workspaceId }),
          sku: input.sku as string,
          name: input.name as string,
          isActive: true,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    update: async (workspaceId, id, input) => {
      const row = products.update(id, workspaceId, input as Partial<StoredProduct>)
      return row ? asRecord(row) : null
    },
    replacePrices: async () => [],
    softDelete: async (workspaceId, id) => {
      products.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      products.restore(id, workspaceId)
    },
  }
  return createProductsService({ store, audit: async () => undefined })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over an in-memory store. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: ProductsService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/products", createRoutes({ service }))
  return app
}

describe("api/products", () => {
  let session: { current: Session | null }
  let service: ProductsService
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
    const res = await api.get("/api/v1/products")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope", async () => {
    await service.create(ctx, { sku: "SKU-001", name: "Widget" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/products")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get returns the product with prices; unknown id is NOT_FOUND", async () => {
    const created = await service.create(ctx, { sku: "SKU-001", name: "Widget" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/products/${created.id}`)
    expect(ok.status).toBe(200)
    const data = ok.expectSuccess().data as { id: string; prices: unknown[] }
    expect(data.id).toBe(created.id)
    expect(data.prices).toEqual([])
    const missing = await api.get("/api/v1/products/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/products", { sku: "SKU-1", name: "  " })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/products", { sku: "SKU-001", name: "Widget" })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { sku: string }).sku).toBe("SKU-001")
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/products", { sku: "SKU-9", name: "Nope" })
    expect(res.status).toBe(403)
    const err = res.expectError("FORBIDDEN")
    expect(err.error.message).toContain("create")
  })

  test("update, delete and restore round-trip", async () => {
    const created = await service.create(ctx, { sku: "SKU-001", name: "Widget" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/products/${created.id}`, { name: "Super Widget" })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/products/${created.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/products/${created.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/products/${created.id}/restore`)
    expect(restored.status).toBe(200)
    const back = await api.get(`/api/v1/products/${created.id}`)
    expect(back.status).toBe(200)
  })
})
