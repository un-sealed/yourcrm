import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { createBaseRepository } from "./base-repository"
import { taggables, tags, type Tag, type Taggable } from "../schema/tags"
import { createTagsRepository, normalizeTagName, validateTagColor } from "./tags-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const MIGRATION = new URL("../../migrations/0003_shared_tables.sql", import.meta.url)

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

function makeTag(overrides: Partial<Tag> = {}): Tag {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    name: "VIP",
    color: "#6366F1",
    ...overrides,
  }
}

function makeTaggable(overrides: Partial<Taggable> = {}): Taggable {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    tagId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    objectType: "person",
    recordId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ...overrides,
  }
}

// Compile-time proof: tag tables satisfy the BaseTable contract.
createBaseRepository(taggables)

describe("tags/schema", () => {
  test("tags expose the BaseRecord column contract", () => {
    const cols = tags as unknown as Record<string, unknown>
    for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
      expect(cols[col], col).toBeDefined()
    }
    expect(cols.name).toBeDefined()
    expect(cols.color).toBeDefined()
  })

  test("taggables carry a tag FK plus plain polymorphic columns", () => {
    const cols = taggables as unknown as Record<string, unknown>
    expect(cols.tagId).toBeDefined()
    expect(cols.objectType).toBeDefined()
    expect(cols.recordId).toBeDefined()
    expect(cols.workspaceId).toBeDefined()
  })
})

describe("tags/normalize", () => {
  test("trims and collapses whitespace", () => {
    expect(normalizeTagName("  Hot   Lead ")).toBe("Hot Lead")
  })

  test("rejects empty names", () => {
    expect(() => normalizeTagName("   ")).toThrow()
  })

  test("rejects overlong names", () => {
    expect(() => normalizeTagName("x".repeat(129))).toThrow()
  })

  test("accepts hex colors and null", () => {
    expect(validateTagColor("#6366F1")).toBe("#6366F1")
    expect(validateTagColor("#fff")).toBe("#fff")
    expect(validateTagColor(null)).toBeNull()
    expect(validateTagColor(undefined)).toBeNull()
  })

  test("rejects non-hex colors", () => {
    expect(() => validateTagColor("red")).toThrow()
    expect(() => validateTagColor("#gggggg")).toThrow()
  })
})

describe("tags/repository", () => {
  test("create returns the inserted row", async () => {
    const repo = createTagsRepository()
    const row = makeTag()
    const result = await repo.create(mockDb([[row]]), WS, { name: "VIP", color: "#6366F1" })
    expect(result).toBe(row)
  })

  test("create rejects empty names before touching the db", async () => {
    const repo = createTagsRepository()
    await expect(repo.create(mockDb(), WS, { name: "  " })).rejects.toThrow()
  })

  test("create surfaces empty insert results as errors", async () => {
    const repo = createTagsRepository()
    await expect(repo.create(mockDb([[]]), WS, { name: "VIP" })).rejects.toThrow()
  })

  test("listByRecord returns the joined tags", async () => {
    const repo = createTagsRepository()
    const rows = [makeTag(), makeTag({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Warm" })]
    const result = await repo.listByRecord(mockDb([rows]), WS, "person", "record-1")
    expect(result).toEqual(rows)
  })

  test("attach restores a soft-deleted link", async () => {
    const repo = createTagsRepository()
    const link = makeTaggable()
    const result = await repo.attach(mockDb([[link]]), WS, "tag-1", "person", "record-1")
    expect(result).toEqual(link)
  })

  test("attach inserts when no link exists", async () => {
    const repo = createTagsRepository()
    const link = makeTaggable({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" })
    const result = await repo.attach(mockDb([[], [link]]), WS, "tag-1", "person", "record-1")
    expect(result).toEqual(link)
  })

  test("detach resolves without a row", async () => {
    const repo = createTagsRepository()
    await repo.detach(mockDb([[]]), WS, "tag-1", "person", "record-1")
  })

  test("base list keeps the cursor pagination envelope", async () => {
    const repo = createTagsRepository()
    const rows = [makeTag({ id: "id-1" }), makeTag({ id: "id-2" }), makeTag({ id: "id-3" })]
    const result = await repo.list(mockDb([rows]), { workspaceId: WS, limit: 2 })
    expect(result.data).toHaveLength(2)
    expect(result.pagination).toEqual({ nextCursor: "id-2", limit: 2 })
  })

  test("findById returns null when missing", async () => {
    const repo = createTagsRepository()
    await expect(repo.findById(mockDb([[]]), WS, "missing")).resolves.toBeNull()
  })
})

describe("tags/migration", () => {
  test("0003 creates tags/taggables with the agreed indexes", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS tags")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS taggables")
    expect(sql).toContain("tags_workspace_name_uidx")
    expect(sql).toContain("lower(name)")
    expect(sql).toContain("taggables_object_record_idx")
    expect(sql).toContain("ON taggables (object_type, record_id)")
    expect(sql).toContain("REFERENCES tags (id) ON DELETE CASCADE")
  })

  test("taggable record references stay FK-free", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const block = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS taggables"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS relationships"),
    )
    expect(block).toContain("record_id UUID NOT NULL")
    expect(block).not.toContain("REFERENCES people")
  })
})
