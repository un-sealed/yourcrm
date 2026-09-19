import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createCompaniesService, type CompaniesService } from "@yourcrm/crm/src/companies"
import type { CompaniesStore, CompanyRecord } from "@yourcrm/crm/src/companies"
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
import { createRoutes } from "./companies"

type StoredCompany = BaseRecord & { name: string; industry: string | null }

function asRecord(row: StoredCompany): CompanyRecord {
  return row as unknown as CompanyRecord
}

/** Real domain service over a hermetic in-memory store. */
function makeFakeService() {
  const companies = createStore<StoredCompany>()
  const store: CompaniesStore = {
    list: async (workspaceId, query) => {
      const rows = companies.list(workspaceId)
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
      const row = companies.get(id, workspaceId)
      return row ? asRecord(row) : null
    },
    findWithAddresses: async (workspaceId, id) => {
      const row = companies.get(id, workspaceId)
      if (!row) return null
      return { company: asRecord(row), addresses: [] }
    },
    listChildren: async () => [],
    create: async (workspaceId, input, actorId) => {
      return asRecord(
        companies.insert({
          ...makeBaseRecord({ workspaceId }),
          name: input.name as string,
          industry: null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    update: async (workspaceId, id, input) => {
      const row = companies.update(id, workspaceId, input as Partial<StoredCompany>)
      return row ? asRecord(row) : null
    },
    softDelete: async (workspaceId, id) => {
      companies.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      companies.restore(id, workspaceId)
    },
  }
  return createCompaniesService({ store, audit: async () => undefined })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over an in-memory store. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: CompaniesService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/companies", createRoutes({ service }))
  return app
}

describe("api/companies", () => {
  let session: { current: Session | null }
  let service: CompaniesService
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
    const res = await api.get("/api/v1/companies")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope", async () => {
    await service.create(ctx, { name: "Acme" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/companies")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get returns the company with addresses and children; unknown id is NOT_FOUND", async () => {
    const created = await service.create(ctx, { name: "Acme" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/companies/${created.id}`)
    expect(ok.status).toBe(200)
    const data = ok.expectSuccess().data as {
      id: string
      addresses: unknown[]
      children: unknown[]
    }
    expect(data.id).toBe(created.id)
    expect(data.addresses).toEqual([])
    expect(data.children).toEqual([])
    const missing = await api.get("/api/v1/companies/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/companies", { name: "  " })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/companies", { name: "Acme", industry: "Software" })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { name: string }).name).toBe("Acme")
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/companies", { name: "Nope" })
    expect(res.status).toBe(403)
    const err = res.expectError("FORBIDDEN")
    expect(err.error.message).toContain("create")
  })

  test("update, delete and restore round-trip", async () => {
    const created = await service.create(ctx, { name: "Acme" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/companies/${created.id}`, { industry: "Software" })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/companies/${created.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/companies/${created.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/companies/${created.id}/restore`)
    expect(restored.status).toBe(200)
    const back = await api.get(`/api/v1/companies/${created.id}`)
    expect(back.status).toBe(200)
  })
})
