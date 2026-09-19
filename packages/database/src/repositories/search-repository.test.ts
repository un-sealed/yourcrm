import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { isSearchObjectType, isSearchVisibility, searchIndex } from "../schema/search"
import {
  buildSnippet,
  createSearchRepository,
  decodeSearchCursor,
  encodeSearchCursor,
  normalizeSearchTitle,
  SEARCH_BODY_MAX_LENGTH,
  searchTerms,
  toTsQuery,
  truncateSearchBody,
  type SearchDocument,
} from "./search-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const RECORD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ACTOR_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const MIGRATION = new URL("../../migrations/0110_search.sql", import.meta.url)

/** Thenable chain stub: every query builder call returns the proxy; each await pops one result. */
function mockDb(queued: unknown[][] = []) {
  let step = 0
  const proxy = new Proxy(function () {}, {
    get(_target, prop: string | symbol) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void) => {
          resolve(queued[step] ?? [])
          step += 1
        }
      }
      return (..._args: unknown[]) => proxy
    },
  })
  return proxy as unknown as Database
}

function makeDocument(overrides: Partial<SearchDocument> = {}): SearchDocument {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ownerId: null,
    objectType: "person",
    recordId: RECORD_ID,
    title: "Ada Lovelace",
    subtitle: "Engineer at Analytical Engines",
    body: "Notes about Ada",
    visibility: "workspace",
    recordUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }
}

describe("search/schema", () => {
  test("search_index exposes the BaseRecord column contract plus index columns", () => {
    const cols = searchIndex as unknown as Record<string, unknown>
    for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
      expect(cols[col], col).toBeDefined()
    }
    for (const col of ["objectType", "recordId", "title", "body", "visibility", "ownerId"]) {
      expect(cols[col], col).toBeDefined()
    }
    expect(cols.searchVector).toBeDefined()
  })

  test("object type and visibility guards reject unknown values", () => {
    expect(isSearchObjectType("person")).toBe(true)
    expect(isSearchObjectType("unicorn")).toBe(false)
    expect(isSearchVisibility("private")).toBe(true)
    expect(isSearchVisibility("secret")).toBe(false)
  })
})

describe("search/tokenizer", () => {
  test("terms drop punctuation and casing", () => {
    expect(searchTerms("  Ada, Lovelace!  ")).toEqual(["ada", "lovelace"])
  })

  test("tsquery prefix-matches every term", () => {
    expect(toTsQuery("ada lov")).toBe("ada:* & lov:*")
  })

  test("tsquery is null when nothing is searchable", () => {
    expect(toTsQuery("   ---   ")).toBeNull()
  })

  test("tsquery cannot smuggle operators out of user text", () => {
    expect(toTsQuery("ada | lovelace & !x")).toBe("ada:* & lovelace:* & x:*")
  })
})

describe("search/snippet", () => {
  test("short bodies come back whole; empty bodies come back null", () => {
    expect(buildSnippet("Ada Lovelace", "ada")).toBe("Ada Lovelace")
    expect(buildSnippet("   ", "ada")).toBeNull()
    expect(buildSnippet(null, "ada")).toBeNull()
  })

  test("long bodies are centred on the first matching term", () => {
    const body = `${"x ".repeat(200)}needle ${"y ".repeat(200)}`
    const snippet = buildSnippet(body, "needle")
    expect(snippet).toContain("needle")
    expect(snippet?.startsWith("…")).toBe(true)
    expect(snippet?.endsWith("…")).toBe(true)
  })

  test("long bodies without a match truncate from the start", () => {
    const snippet = buildSnippet("z".repeat(500), "needle")
    expect(snippet).toHaveLength(161)
    expect(snippet?.endsWith("…")).toBe(true)
  })
})

describe("search/cursor", () => {
  test("round-trips an offset and defaults to zero", () => {
    expect(decodeSearchCursor(encodeSearchCursor(40))).toBe(40)
    expect(decodeSearchCursor(undefined)).toBe(0)
    expect(decodeSearchCursor(null)).toBe(0)
    expect(decodeSearchCursor("")).toBe(0)
  })

  test("rejects tokens it did not mint", () => {
    expect(() => decodeSearchCursor("-1")).toThrow(/cursor/)
    expect(() => decodeSearchCursor("'; DROP TABLE search_index; --")).toThrow(/cursor/)
  })
})

describe("search/validation", () => {
  test("titles trim, collapse whitespace and reject empties", () => {
    expect(normalizeSearchTitle("  Ada   Lovelace ")).toBe("Ada Lovelace")
    expect(() => normalizeSearchTitle("   ")).toThrow(/title/)
    expect(() => normalizeSearchTitle("x".repeat(513))).toThrow(/title/)
  })

  test("bodies truncate instead of failing the index write", () => {
    expect(truncateSearchBody("x".repeat(SEARCH_BODY_MAX_LENGTH + 100))).toHaveLength(
      SEARCH_BODY_MAX_LENGTH,
    )
  })
})

describe("search/repository", () => {
  test("upsert returns the stored document", async () => {
    const repo = createSearchRepository()
    const row = makeDocument()
    const result = await repo.upsert(mockDb([[row]]), WS, {
      objectType: "person",
      recordId: RECORD_ID,
      title: "Ada Lovelace",
    })
    expect(result).toBe(row)
  })

  test("upsert rejects unknown object types before touching the db", async () => {
    const repo = createSearchRepository()
    await expect(
      repo.upsert(mockDb(), WS, { objectType: "unicorn", recordId: RECORD_ID, title: "Ada" }),
    ).rejects.toThrow(/objectType/)
  })

  test("upsert rejects unknown visibility values", async () => {
    const repo = createSearchRepository()
    await expect(
      repo.upsert(mockDb(), WS, {
        objectType: "person",
        recordId: RECORD_ID,
        title: "Ada",
        visibility: "secret",
      }),
    ).rejects.toThrow(/visibility/)
  })

  test("upsert rejects an unparseable recordUpdatedAt", async () => {
    const repo = createSearchRepository()
    await expect(
      repo.upsert(mockDb(), WS, {
        objectType: "person",
        recordId: RECORD_ID,
        title: "Ada",
        recordUpdatedAt: "not-a-date",
      }),
    ).rejects.toThrow(/recordUpdatedAt/)
  })

  test("upsert surfaces empty insert results as errors", async () => {
    const repo = createSearchRepository()
    await expect(
      repo.upsert(mockDb([[]]), WS, { objectType: "person", recordId: RECORD_ID, title: "Ada" }),
    ).rejects.toThrow(/no rows/)
  })

  test("removeByRecord reports how many rows it soft-deleted", async () => {
    const repo = createSearchRepository()
    await expect(
      repo.removeByRecord(mockDb([[{ id: "1" }]]), WS, "person", RECORD_ID, ACTOR_ID),
    ).resolves.toBe(1)
    await expect(repo.removeByRecord(mockDb([[]]), WS, "person", RECORD_ID)).resolves.toBe(0)
  })

  test("removeByRecord rejects unknown object types", async () => {
    const repo = createSearchRepository()
    await expect(repo.removeByRecord(mockDb(), WS, "unicorn", RECORD_ID)).rejects.toThrow(
      /objectType/,
    )
  })

  test("findByRecord returns null when nothing is indexed", async () => {
    const repo = createSearchRepository()
    await expect(repo.findByRecord(mockDb([[]]), WS, "person", RECORD_ID)).resolves.toBeNull()
  })

  test("query returns the cursor pagination envelope with snippets", async () => {
    const repo = createSearchRepository()
    const rows = [
      { ...makeDocument({ id: "id-1" }), rank: 0.9 },
      { ...makeDocument({ id: "id-2" }), rank: 0.5 },
      { ...makeDocument({ id: "id-3" }), rank: 0.1 },
    ]
    const result = await repo.query(mockDb([rows]), {
      workspaceId: WS,
      query: "ada",
      objects: ["person"],
      limit: 2,
    })
    expect(result.data).toHaveLength(2)
    expect(result.pagination).toEqual({ nextCursor: "2", limit: 2 })
    expect(result.data[0]).toMatchObject({ objectType: "person", rank: 0.9 })
    expect(result.data[0]?.snippet).toBe("Notes about Ada")
    // The raw body never leaves the repository: hits carry a snippet only.
    expect(result.data[0]).not.toHaveProperty("body")
  })

  test("query short-circuits when the caller may read no object type", async () => {
    const repo = createSearchRepository()
    const result = await repo.query(mockDb([[makeDocument()]]), {
      workspaceId: WS,
      query: "ada",
      objects: [],
    })
    expect(result.data).toEqual([])
    expect(result.pagination).toEqual({ nextCursor: null, limit: 20 })
  })

  test("query short-circuits on text with no searchable term", async () => {
    const repo = createSearchRepository()
    const result = await repo.query(mockDb([[makeDocument()]]), {
      workspaceId: WS,
      query: "***",
      objects: ["person"],
    })
    expect(result.data).toEqual([])
  })

  test("query rejects an object-type filter it does not know", async () => {
    const repo = createSearchRepository()
    await expect(
      repo.query(mockDb(), { workspaceId: WS, query: "ada", objects: ["unicorn"] }),
    ).rejects.toThrow(/objectType/)
  })
})

describe("search/migration", () => {
  test("0110 creates search_index with the generated tsvector and GIN index", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS search_index")
    expect(sql).toContain("search_vector TSVECTOR GENERATED ALWAYS AS")
    expect(sql).toContain("USING GIN (search_vector)")
    expect(sql).toContain("search_index_record_uidx")
    expect(sql).toContain("ON search_index (workspace_id, object_type, record_id)")
  })

  test("record references stay FK-free", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const block = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS search_index"),
      sql.indexOf("CREATE INDEX IF NOT EXISTS search_index_workspace_idx"),
    )
    expect(block).toContain("record_id UUID NOT NULL")
    expect(block).not.toContain("REFERENCES")
  })
})
