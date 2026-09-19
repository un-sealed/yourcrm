import { beforeEach, describe, expect, test } from "bun:test"
import {
  createStore,
  expectAllowed,
  expectDenied,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import {
  canReadAllRecords,
  canReadSearchDocument,
  createSearchService,
  readableSearchObjects,
  SEARCH_OBJECT_TYPES,
  type SearchDocumentRecord,
  type SearchHitRecord,
  type SearchStore,
  type SearchStoreQuery,
} from "./index"
import type { SearchAuditInput } from "./types"

type StoredDocument = BaseRecord & {
  objectType: string
  recordId: string
  title: string
  subtitle: string | null
  body: string | null
  ownerId: string | null
  visibility: string
  recordUpdatedAt: string
}

function asDocument(row: StoredDocument): SearchDocumentRecord {
  return row as unknown as SearchDocumentRecord
}

function terms(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0)
}

/** Project a stored row onto a hit: the indexed body becomes a snippet. */
function toHit(row: StoredDocument, rank: number): SearchHitRecord {
  const hit: Record<string, unknown> = { ...row, rank, snippet: row.body }
  delete hit.body
  return hit as unknown as SearchHitRecord
}

/**
 * Hermetic `SearchStore` backed by the shared in-memory store. It reproduces
 * the repository's two permission filters (object types + record visibility)
 * so the service tests prove the same behaviour the SQL enforces.
 */
function makeStore() {
  const documents = createStore<StoredDocument>()
  const key = (objectType: string, recordId: string) => `${objectType}:${recordId}`

  const find = (workspaceId: string, objectType: string, recordId: string) =>
    documents
      .list(workspaceId)
      .find((row) => key(row.objectType, row.recordId) === key(objectType, recordId)) ?? null

  const store: SearchStore = {
    query: async (workspaceId: string, query: SearchStoreQuery) => {
      const wanted = terms(query.query)
      const limit = query.limit ?? 20
      const offset = query.cursor === undefined ? 0 : Number(query.cursor)
      const matched = documents
        .list(workspaceId)
        .filter((row) => query.objects.includes(row.objectType))
        .filter((row) => {
          if (query.includePrivate === true) return true
          if (row.visibility !== "private") return true
          return row.ownerId !== null && row.ownerId === query.actorId
        })
        .map((row) => {
          const haystack = `${row.title} ${row.subtitle ?? ""} ${row.body ?? ""}`.toLowerCase()
          const hits = wanted.filter((term) => haystack.includes(term)).length
          return { row, rank: wanted.length === 0 ? 0 : hits / wanted.length }
        })
        .filter((entry) => entry.rank > 0)
        .sort((a, b) => b.rank - a.rank)
      const page = matched.slice(offset, offset + limit)
      const hits: SearchHitRecord[] = page.map(({ row, rank }) => toHit(row, rank))
      return {
        data: hits,
        pagination: {
          nextCursor: matched.length > offset + limit ? String(offset + limit) : null,
          limit,
        },
      }
    },
    upsert: async (workspaceId, input, actorId) => {
      const objectType = input.objectType as string
      const recordId = input.recordId as string
      const existing = find(workspaceId, objectType, recordId)
      const values = {
        objectType,
        recordId,
        title: input.title as string,
        subtitle: (input.subtitle as string | null) ?? null,
        body: (input.body as string | null) ?? null,
        ownerId: (input.ownerId as string | null) ?? null,
        visibility: (input.visibility as string | null) ?? "workspace",
        recordUpdatedAt: (input.recordUpdatedAt as string | null) ?? new Date(0).toISOString(),
      }
      if (existing) {
        const updated = documents.update(existing.id, workspaceId, values)
        if (!updated) throw new Error("search store: update lost the row")
        return asDocument(updated)
      }
      return asDocument(
        documents.insert({
          ...makeBaseRecord({ workspaceId }),
          ...values,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    removeByRecord: async (workspaceId, objectType, recordId) => {
      const existing = find(workspaceId, objectType, recordId)
      if (!existing) return 0
      return documents.remove(existing.id, workspaceId) ? 1 : 0
    },
    findByRecord: async (workspaceId, objectType, recordId) => {
      const row = find(workspaceId, objectType, recordId)
      return row ? asDocument(row) : null
    },
  }

  return { documents, store }
}

function setup(
  role: "owner" | "admin" | "member" | "viewer" = "owner",
  shared?: ReturnType<typeof makeStore>,
  options: { workspaceId?: string; userId?: string } = {},
) {
  const session = makeSession({
    role,
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    ...(options.userId === undefined ? {} : { userId: options.userId }),
  })
  const ctx = makeServiceContext({ session })
  const audits: SearchAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createSearchService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

describe("search/policy", () => {
  test("a member may read every indexed object type", () => {
    const ctx = makeServiceContext({ session: makeSession({ role: "member" }) })
    expect(readableSearchObjects(ctx)).toEqual([...SEARCH_OBJECT_TYPES])
  })

  test("an unidentified actor may read nothing", () => {
    const ctx = makeServiceContext({ workspaceId: "ws_1", actorId: "", role: "member" })
    expect(readableSearchObjects(ctx)).toEqual([])
  })

  test("only workspace admins see private records they do not own", () => {
    const member = makeServiceContext({ session: makeSession({ role: "member" }) })
    const admin = makeServiceContext({ session: makeSession({ role: "admin" }) })
    expect(canReadAllRecords(member)).toBe(false)
    expect(canReadAllRecords(admin)).toBe(true)

    const doc = { objectType: "person", ownerId: "someone-else", visibility: "private" }
    expect(canReadSearchDocument(member, doc)).toBe(false)
    expect(canReadSearchDocument(admin, doc)).toBe(true)
    expect(canReadSearchDocument(member, { ...doc, ownerId: member.actorId })).toBe(true)
    expect(canReadSearchDocument(member, { ...doc, visibility: "workspace" })).toBe(true)
  })
})

describe("search/service", () => {
  test("indexRecord validates, stores and audits the document", async () => {
    const { ctx, service, audits } = setup()
    const doc = await expectAllowed(() =>
      service.indexRecord(ctx, {
        objectType: "person",
        recordId: "person-1",
        title: "Ada Lovelace",
        body: "Analytical Engine notes",
      }),
    )
    expect(doc.title).toBe("Ada Lovelace")
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      workspaceId: ctx.workspaceId,
      action: "create",
      object: "search_index",
      recordId: doc.id,
      correlationId: ctx.correlationId,
    })
    expect(audits[0]?.after).toMatchObject({ title: "Ada Lovelace" })
  })

  test("indexRecord rejects unknown object types before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(
      service.indexRecord(ctx, { objectType: "unicorn", recordId: "u-1", title: "Nope" }),
    ).rejects.toThrow()
  })

  test("indexRecord is idempotent per record and audits the second write as an update", async () => {
    const { ctx, service, audits } = setup()
    const first = await service.indexRecord(ctx, {
      objectType: "person",
      recordId: "person-1",
      title: "Ada",
    })
    const second = await service.indexRecord(ctx, {
      objectType: "person",
      recordId: "person-1",
      title: "Ada Lovelace",
    })
    expect(second.id).toBe(first.id)
    expect(audits.at(-1)).toMatchObject({ action: "update", recordId: first.id })
    const hits = await service.search(ctx, { query: "ada" })
    expect(hits.data).toHaveLength(1)
    expect(hits.data[0]?.title).toBe("Ada Lovelace")
  })

  test("search returns ranked hits in the shared pagination envelope", async () => {
    const { ctx, service } = setup()
    await service.indexRecord(ctx, {
      objectType: "person",
      recordId: "person-1",
      title: "Ada Lovelace",
      body: "Analytical engine",
    })
    await service.indexRecord(ctx, {
      objectType: "company",
      recordId: "company-1",
      title: "Analytical Engines Ltd",
    })
    const result = await expectAllowed(() => service.search(ctx, { query: "analytical" }))
    expect(result.data).toHaveLength(2)
    expect(result.pagination).toEqual({ nextCursor: null, limit: 20 })
    expect(result.data.every((hit) => typeof hit.rank === "number")).toBe(true)
  })

  test("search honours the object-type filter and paginates by cursor", async () => {
    const { ctx, service } = setup()
    for (const n of [1, 2, 3]) {
      await service.indexRecord(ctx, {
        objectType: "person",
        recordId: `person-${n}`,
        title: `Ada ${n}`,
      })
    }
    await service.indexRecord(ctx, {
      objectType: "deal",
      recordId: "deal-1",
      title: "Ada renewal",
    })

    const onlyPeople = await service.search(ctx, { query: "ada", object: "person" })
    expect(onlyPeople.data).toHaveLength(3)
    expect(onlyPeople.data.every((hit) => hit.objectType === "person")).toBe(true)

    const firstPage = await service.search(ctx, { query: "ada", limit: 2 })
    expect(firstPage.data).toHaveLength(2)
    expect(firstPage.pagination.nextCursor).toBe("2")
    const secondPage = await service.search(ctx, {
      query: "ada",
      limit: 2,
      cursor: firstPage.pagination.nextCursor ?? undefined,
    })
    expect(secondPage.data).toHaveLength(2)
    expect(secondPage.pagination.nextCursor).toBeNull()
  })

  test("search rejects an empty query and an unknown object filter", async () => {
    const { ctx, service } = setup()
    await expect(service.search(ctx, { query: "   " })).rejects.toThrow()
    await expect(service.search(ctx, { query: "ada", object: "unicorn" })).rejects.toThrow()
  })

  test("getIndexed returns the document; unknown records are NOT_FOUND", async () => {
    const { ctx, service } = setup()
    await service.indexRecord(ctx, {
      objectType: "person",
      recordId: "person-1",
      title: "Ada",
    })
    const found = await expectAllowed(() =>
      service.getIndexed(ctx, { objectType: "person", recordId: "person-1" }),
    )
    expect(found.recordId).toBe("person-1")
    const err = await service
      .getIndexed(ctx, { objectType: "person", recordId: "nope" })
      .catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe("NOT_FOUND")
  })

  test("removeRecord soft-deletes the document, audits it and hides it from search", async () => {
    const { ctx, service, audits } = setup()
    const doc = await service.indexRecord(ctx, {
      objectType: "person",
      recordId: "person-1",
      title: "Ada Lovelace",
    })
    const result = await expectAllowed(() =>
      service.removeRecord(ctx, { objectType: "person", recordId: "person-1" }),
    )
    expect(result).toEqual({ objectType: "person", recordId: "person-1", removed: 1 })
    expect(audits.at(-1)).toMatchObject({
      action: "delete",
      object: "search_index",
      recordId: doc.id,
    })
    const hits = await service.search(ctx, { query: "ada" })
    expect(hits.data).toEqual([])
  })

  test("removeRecord reports NOT_FOUND for records that were never indexed", async () => {
    const { ctx, service } = setup()
    await expect(
      service.removeRecord(ctx, { objectType: "person", recordId: "nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  describe("denials", () => {
    let backing: ReturnType<typeof makeStore>
    let workspaceId: string

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      await owner.service.indexRecord(owner.ctx, {
        objectType: "person",
        recordId: "person-1",
        title: "Ada Lovelace",
      })
    })

    test("viewer cannot index a record", async () => {
      const { ctx, service } = setup("viewer", backing, { workspaceId })
      await expectDenied(() =>
        service.indexRecord(ctx, { objectType: "person", recordId: "person-2", title: "Nope" }),
      )
    })

    test("member cannot remove a record from the index (admin-only)", async () => {
      const { ctx, service } = setup("member", backing, { workspaceId })
      await expectDenied(() =>
        service.removeRecord(ctx, { objectType: "person", recordId: "person-1" }),
      )
    })

    test("an actor outside the workspace is denied outright", async () => {
      const service = createSearchService({
        store: backing.store,
        audit: async () => undefined,
      })
      const ctx = makeServiceContext({ workspaceId, actorId: "", role: "admin" })
      await expectDenied(() => service.search(ctx, { query: "ada" }))
    })

    test("a denied actor cannot see another member's private record", async () => {
      const ownerUserId = "user-owner"
      const other = setup("member", backing, { workspaceId })

      // Index a private record owned by someone else.
      const admin = setup("admin", backing, { workspaceId, userId: ownerUserId })
      await admin.service.indexRecord(admin.ctx, {
        objectType: "deal",
        recordId: "deal-secret",
        title: "Ada confidential renewal",
        ownerId: ownerUserId,
        visibility: "private",
      })

      // The other member searches the same workspace: the private hit is gone,
      // filtered by permissions rather than by workspace scope.
      const denied = await other.service.search(other.ctx, { query: "confidential" })
      expect(denied.data).toEqual([])
      await expect(
        other.service.getIndexed(other.ctx, { objectType: "deal", recordId: "deal-secret" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })

      // Its owner, and any workspace admin, still see it.
      const byOwner = await admin.service.search(admin.ctx, { query: "confidential" })
      expect(byOwner.data).toHaveLength(1)
      const bystanderAdmin = setup("admin", backing, { workspaceId })
      const byAdmin = await bystanderAdmin.service.search(bystanderAdmin.ctx, {
        query: "confidential",
      })
      expect(byAdmin.data).toHaveLength(1)
    })

    test("viewer can still search (read is open to every role)", async () => {
      const { ctx, service } = setup("viewer", backing, { workspaceId })
      const result = await expectAllowed(() => service.search(ctx, { query: "ada" }))
      expect(result.data).toHaveLength(1)
    })
  })
})
