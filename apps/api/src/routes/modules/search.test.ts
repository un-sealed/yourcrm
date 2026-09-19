import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createSearchService, type SearchService } from "@yourcrm/crm/src/search"
import type {
  SearchDocumentRecord,
  SearchHitRecord,
  SearchStore,
  SearchStoreQuery,
} from "@yourcrm/crm/src/search"
import { createApiClient, createStore, makeBaseRecord, makeSession } from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./search"

type StoredDocument = BaseRecord & {
  objectType: string
  recordId: string
  title: string
  body: string | null
  ownerId: string | null
  visibility: string
}

/** Project a stored row onto a hit: the indexed body becomes a snippet. */
function toHit(row: StoredDocument): SearchHitRecord {
  const hit: Record<string, unknown> = { ...row, rank: 1, snippet: row.body }
  delete hit.body
  return hit as unknown as SearchHitRecord
}

/** Real domain service over a hermetic in-memory index. */
function makeFakeService(): SearchService {
  const documents = createStore<StoredDocument>()
  const find = (workspaceId: string, objectType: string, recordId: string) =>
    documents
      .list(workspaceId)
      .find((row) => row.objectType === objectType && row.recordId === recordId) ?? null

  const store: SearchStore = {
    query: async (workspaceId: string, query: SearchStoreQuery) => {
      const needle = query.query.toLowerCase()
      const rows = documents
        .list(workspaceId)
        .filter((row) => query.objects.includes(row.objectType))
        .filter((row) => {
          if (query.includePrivate === true) return true
          if (row.visibility !== "private") return true
          return row.ownerId !== null && row.ownerId === query.actorId
        })
        .filter((row) => `${row.title} ${row.body ?? ""}`.toLowerCase().includes(needle))
      const limit = query.limit ?? 20
      const data = rows.slice(0, limit).map(toHit)
      return {
        data,
        pagination: { nextCursor: rows.length > limit ? String(limit) : null, limit },
      }
    },
    upsert: async (workspaceId, input, actorId) => {
      const objectType = input.objectType as string
      const recordId = input.recordId as string
      const values = {
        objectType,
        recordId,
        title: input.title as string,
        body: (input.body as string | null) ?? null,
        ownerId: (input.ownerId as string | null) ?? null,
        visibility: (input.visibility as string | null) ?? "workspace",
      }
      const existing = find(workspaceId, objectType, recordId)
      if (existing) {
        const updated = documents.update(existing.id, workspaceId, values)
        if (!updated) throw new Error("search store: update lost the row")
        return updated as unknown as SearchDocumentRecord
      }
      return documents.insert({
        ...makeBaseRecord({ workspaceId }),
        ...values,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      }) as unknown as SearchDocumentRecord
    },
    removeByRecord: async (workspaceId, objectType, recordId) => {
      const existing = find(workspaceId, objectType, recordId)
      if (!existing) return 0
      return documents.remove(existing.id, workspaceId) ? 1 : 0
    },
    findByRecord: async (workspaceId, objectType, recordId) => {
      const row = find(workspaceId, objectType, recordId)
      return row ? (row as unknown as SearchDocumentRecord) : null
    },
  }

  return createSearchService({ store, audit: async () => undefined })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over an in-memory index. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: SearchService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/search", createRoutes({ service }))
  return app
}

describe("api/search", () => {
  let session: { current: Session | null }
  let owner: Session
  let service: SearchService

  async function seed(client: ReturnType<typeof createApiClient>, body: unknown) {
    const res = await client.post("/api/v1/search/index", body)
    expect(res.status).toBe(201)
    return res.expectSuccess().data as { id: string }
  }

  beforeEach(() => {
    owner = makeSession({ role: "owner" })
    session = { current: owner }
    service = makeFakeService()
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/search?query=ada")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("search returns the cursor pagination envelope", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    await seed(api, { objectType: "person", recordId: "person-1", title: "Ada Lovelace" })
    const res = await api.get("/api/v1/search?query=ada")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 20 })
    expect((body.data as { objectType: string }[])[0]?.objectType).toBe("person")
  })

  test("search validates the query string", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const missing = await api.get("/api/v1/search")
    expect(missing.status).toBe(400)
    missing.expectError("VALIDATION_ERROR")
    const unknownObject = await api.get("/api/v1/search?query=ada&object=unicorn")
    expect(unknownObject.status).toBe(400)
    unknownObject.expectError("VALIDATION_ERROR")
  })

  test("search honours the object filter", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    await seed(api, { objectType: "person", recordId: "person-1", title: "Ada Lovelace" })
    await seed(api, { objectType: "deal", recordId: "deal-1", title: "Ada renewal" })
    const res = await api.get("/api/v1/search?query=ada&object=deal")
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect((body.data as { objectType: string }[])[0]?.objectType).toBe("deal")
  })

  test("indexing validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/search/index", { objectType: "unicorn", recordId: "1" })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/search/index", {
      objectType: "person",
      recordId: "person-1",
      title: "Ada Lovelace",
    })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { title: string }).title).toBe("Ada Lovelace")
  })

  test("get and delete round-trip an indexed record", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    await seed(api, { objectType: "person", recordId: "person-1", title: "Ada Lovelace" })
    const found = await api.get("/api/v1/search/index/person/person-1")
    expect(found.status).toBe(200)
    const deleted = await api.delete("/api/v1/search/index/person/person-1")
    expect(deleted.status).toBe(200)
    expect(deleted.expectSuccess().data).toMatchObject({ removed: 1 })
    const gone = await api.get("/api/v1/search/index/person/person-1")
    expect(gone.status).toBe(404)
    gone.expectError("NOT_FOUND")
  })

  test("an unknown object type in the path is a validation error", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/search/index/unicorn/u-1")
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("viewer indexing is FORBIDDEN (service denial maps to 403)", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    session.current = makeSession({ role: "viewer", workspaceId: owner.workspaceId })
    const res = await api.post("/api/v1/search/index", {
      objectType: "person",
      recordId: "person-9",
      title: "Nope",
    })
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
  })

  test("member deleting from the index is FORBIDDEN", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    await seed(api, { objectType: "person", recordId: "person-1", title: "Ada Lovelace" })
    session.current = makeSession({ role: "member", workspaceId: owner.workspaceId })
    const res = await api.delete("/api/v1/search/index/person/person-1")
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
  })

  test("results are filtered by permissions, not just by workspace", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    await seed(api, {
      objectType: "deal",
      recordId: "deal-secret",
      title: "Ada confidential renewal",
      ownerId: owner.user.id,
      visibility: "private",
    })

    // A member of the same workspace never sees another actor's private record.
    session.current = makeSession({ role: "member", workspaceId: owner.workspaceId })
    const denied = await api.get("/api/v1/search?query=confidential")
    expect(denied.expectSuccess().data).toEqual([])
    const probed = await api.get("/api/v1/search/index/deal/deal-secret")
    expect(probed.status).toBe(404)

    // Its owner still does.
    session.current = owner
    const allowed = await api.get("/api/v1/search?query=confidential")
    expect(allowed.expectSuccess().data).toHaveLength(1)
  })

  test("search results are scoped to the caller's workspace", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    await seed(api, { objectType: "person", recordId: "person-1", title: "Ada Lovelace" })
    session.current = makeSession({ role: "owner" })
    const res = await api.get("/api/v1/search?query=ada")
    expect(res.expectSuccess().data).toEqual([])
  })
})
