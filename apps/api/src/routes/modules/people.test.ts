import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createPeopleService, type PeopleService } from "@yourcrm/crm/src/people"
import type { PeopleStore, PersonRecord } from "@yourcrm/crm/src/people"
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
import { createRoutes } from "./people"

type StoredPerson = BaseRecord & { firstName: string; lastName: string | null }

function asRecord(row: StoredPerson): PersonRecord {
  return row as unknown as PersonRecord
}

/** Real domain service over a hermetic in-memory store. */
function makeFakeService() {
  const people = createStore<StoredPerson>()
  const store: PeopleStore = {
    list: async (workspaceId, query) => {
      const rows = people.list(workspaceId)
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
      const row = people.get(id, workspaceId)
      return row ? asRecord(row) : null
    },
    findWithContacts: async (workspaceId, id) => {
      const row = people.get(id, workspaceId)
      if (!row) return null
      return { person: asRecord(row), emails: [], phones: [] }
    },
    create: async (workspaceId, input, actorId) => {
      return asRecord(
        people.insert({
          ...makeBaseRecord({ workspaceId }),
          firstName: input.firstName as string,
          lastName: null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    update: async (workspaceId, id, input) => {
      const row = people.update(id, workspaceId, input as Partial<StoredPerson>)
      return row ? asRecord(row) : null
    },
    softDelete: async (workspaceId, id) => {
      people.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      people.restore(id, workspaceId)
    },
  }
  return createPeopleService({ store, audit: async () => undefined })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over an in-memory store. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: PeopleService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/people", createRoutes({ service }))
  return app
}

describe("api/people", () => {
  let session: { current: Session | null }
  let service: PeopleService
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
    const res = await api.get("/api/v1/people")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope", async () => {
    await service.create(ctx, { firstName: "Ada" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/people")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get returns the person with contacts; unknown id is NOT_FOUND", async () => {
    const created = await service.create(ctx, { firstName: "Ada" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/people/${created.id}`)
    expect(ok.status).toBe(200)
    const data = ok.expectSuccess().data as { id: string; emails: unknown[]; phones: unknown[] }
    expect(data.id).toBe(created.id)
    expect(data.emails).toEqual([])
    expect(data.phones).toEqual([])
    const missing = await api.get("/api/v1/people/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/people", { firstName: "  " })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/people", { firstName: "Ada", lastName: "Lovelace" })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { firstName: string }).firstName).toBe("Ada")
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/people", { firstName: "Nope" })
    expect(res.status).toBe(403)
    const err = res.expectError("FORBIDDEN")
    expect(err.error.message).toContain("create")
  })

  test("update, delete and restore round-trip", async () => {
    const created = await service.create(ctx, { firstName: "Ada" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/people/${created.id}`, { title: "CTO" })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/people/${created.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/people/${created.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/people/${created.id}/restore`)
    expect(restored.status).toBe(200)
    const back = await api.get(`/api/v1/people/${created.id}`)
    expect(back.status).toBe(200)
  })
})
