import { describe, expect, test } from "bun:test"
import {
  SearchActorRequiredError,
  createPostgresSearchProvider,
  firstLine,
  type PermissionAwareSearchStore,
} from "./postgres-provider"

type Row = { objectType: string; recordId: string; title: string; rank: number; snippet?: string }

type Call = { ctx: unknown; query: unknown }

function makeStore(rows: Row[]) {
  const searches: Call[] = []
  const indexed: Call[] = []
  const store: PermissionAwareSearchStore = {
    search: async (ctx, query) => {
      searches.push({ ctx, query })
      const filtered = query.object ? rows.filter((r) => r.objectType === query.object) : rows
      return { data: filtered, pagination: { nextCursor: null, limit: query.limit ?? 20 } }
    },
    indexRecord: async (ctx, document) => {
      indexed.push({ ctx, query: document })
      return document
    },
  }
  return { store, searches, indexed }
}

const ROWS: Row[] = [
  { objectType: "person", recordId: "p1", title: "Ada Lovelace", rank: 0.9, snippet: "notes" },
  { objectType: "deal", recordId: "d1", title: "Ada renewal", rank: 0.4 },
]

describe("search/postgres-provider", () => {
  test("is named so callers can tell it apart from the noop provider", () => {
    const { store } = makeStore(ROWS)
    const provider = createPostgresSearchProvider({
      store,
      resolveActor: () => ({ actorId: "u1" }),
    })
    expect(provider.name).toBe("postgres-fts")
  })

  test("maps store rows onto the SearchHit contract", async () => {
    const { store } = makeStore(ROWS)
    const provider = createPostgresSearchProvider({
      store,
      resolveActor: () => ({ actorId: "u1", role: "member" }),
    })
    const result = await provider.search({ workspaceId: "ws1", query: "ada", limit: 20 })
    expect(result.query).toBe("ada")
    expect(result.hits[0]).toEqual({
      object: "person",
      recordId: "p1",
      title: "Ada Lovelace",
      rank: 0.9,
      snippet: "notes",
    })
    expect(result.hits[1]?.snippet).toBeUndefined()
  })

  test("passes the resolved actor through so the store can filter results", async () => {
    const { store, searches } = makeStore(ROWS)
    const provider = createPostgresSearchProvider({
      store,
      resolveActor: async () => ({ actorId: "u1", role: "admin" }),
    })
    await provider.search({ workspaceId: "ws1", query: "ada", limit: 20 })
    expect(searches[0]?.ctx).toEqual({ workspaceId: "ws1", actorId: "u1", role: "admin" })
  })

  test("fails closed when no actor can be resolved", async () => {
    const { store, searches } = makeStore(ROWS)
    const provider = createPostgresSearchProvider({ store, resolveActor: () => null })
    const err = await provider
      .search({ workspaceId: "ws1", query: "ada", limit: 20 })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SearchActorRequiredError)
    expect((err as { code: string }).code).toBe("FORBIDDEN")
    expect(searches).toHaveLength(0)
  })

  test("a single object filter becomes one scan", async () => {
    const { store, searches } = makeStore(ROWS)
    const provider = createPostgresSearchProvider({
      store,
      resolveActor: () => ({ actorId: "u1" }),
    })
    const result = await provider.search({
      workspaceId: "ws1",
      query: "ada",
      objects: ["person"],
      limit: 20,
    })
    expect(searches).toHaveLength(1)
    expect(result.hits.map((h) => h.object)).toEqual(["person"])
  })

  test("several object filters merge by rank and respect the limit", async () => {
    const { store, searches } = makeStore(ROWS)
    const provider = createPostgresSearchProvider({
      store,
      resolveActor: () => ({ actorId: "u1" }),
    })
    const result = await provider.search({
      workspaceId: "ws1",
      query: "ada",
      objects: ["deal", "person"],
      limit: 1,
    })
    expect(searches).toHaveLength(2)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.object).toBe("person")
  })

  test("rejects a query the shared schema refuses", async () => {
    const { store } = makeStore(ROWS)
    const provider = createPostgresSearchProvider({
      store,
      resolveActor: () => ({ actorId: "u1" }),
    })
    await expect(provider.search({ workspaceId: "ws1", query: "", limit: 20 })).rejects.toThrow()
  })

  test("indexDocument writes through the permission-aware store", async () => {
    const { store, indexed } = makeStore(ROWS)
    const provider = createPostgresSearchProvider({
      store,
      resolveActor: () => ({ actorId: "u1" }),
    })
    await provider.indexDocument?.({
      object: "person",
      recordId: "p1",
      workspaceId: "ws1",
      text: "Ada Lovelace\nAnalytical engine notes",
    })
    expect(indexed).toHaveLength(1)
    expect(indexed[0]?.query).toMatchObject({
      objectType: "person",
      recordId: "p1",
      title: "Ada Lovelace",
    })
  })
})

describe("search/firstLine", () => {
  test("takes the first non-empty line and collapses whitespace", () => {
    expect(firstLine("\n\n  Ada   Lovelace \nmore")).toBe("Ada Lovelace")
  })

  test("truncates overlong titles and rejects empty text", () => {
    expect(firstLine("x".repeat(600))).toHaveLength(512)
    expect(() => firstLine("   \n  ")).toThrow()
  })
})
