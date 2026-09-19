import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { createBaseRepository } from "./base-repository"
import { savedViews, type SavedView, type SavedViewFilterNode } from "../schema/saved-views"
import {
  createSavedViewsRepository,
  validateSavedViewColumns,
  validateSavedViewFilters,
  validateSavedViewSort,
} from "./saved-views-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const OWNER = "22222222-2222-4222-8222-222222222222"
const MIGRATION = new URL("../../migrations/0003_shared_tables.sql", import.meta.url)

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

function makeView(overrides: Partial<SavedView> = {}): SavedView {
  return {
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ownerId: OWNER,
    objectType: "person",
    name: "My hot leads",
    isShared: false,
    filter: { op: "and", conditions: [{ field: "status", operator: "eq", value: "hot" }] },
    columns: [{ key: "name" }, { key: "status", width: 160 }],
    sort: [{ field: "createdAt", direction: "desc" }],
    ...overrides,
  }
}

// Compile-time proof: saved_views satisfy the BaseTable contract.
createBaseRepository(savedViews)

describe("saved-views/schema", () => {
  test("views expose the expected columns", () => {
    const cols = savedViews as unknown as Record<string, unknown>
    for (const col of ["id", "workspaceId", "ownerId", "objectType", "name", "isShared"]) {
      expect(cols[col], col).toBeDefined()
    }
    expect(cols.filter).toBeDefined()
    expect(cols.columns).toBeDefined()
    expect(cols.sort).toBeDefined()
  })
})

describe("saved-views/filter-validation", () => {
  test("accepts empty filters and valid groups", () => {
    expect(validateSavedViewFilters(null)).toBeNull()
    expect(validateSavedViewFilters(undefined)).toBeNull()
    expect(
      validateSavedViewFilters({
        op: "or",
        conditions: [
          { field: "status", operator: "eq", value: "hot" },
          {
            op: "and",
            conditions: [{ field: "score", operator: "gte", value: 50 }],
          },
        ],
      }),
    ).toBeNull()
  })

  test("rejects a leaf at the root", () => {
    expect(validateSavedViewFilters({ field: "status", operator: "eq" })).not.toBeNull()
  })

  test("rejects empty groups, bad operators and missing fields", () => {
    expect(validateSavedViewFilters({ op: "and", conditions: [] })).not.toBeNull()
    expect(
      validateSavedViewFilters({
        op: "and",
        conditions: [{ field: "status", operator: "LIKE" }],
      }),
    ).not.toBeNull()
    expect(validateSavedViewFilters({ op: "and", conditions: [{ operator: "eq" }] })).not.toBeNull()
    expect(validateSavedViewFilters({ op: "and", conditions: [null] })).not.toBeNull()
    expect(validateSavedViewFilters("status = 'hot'")).not.toBeNull()
  })
})

describe("saved-views/columns-sort-validation", () => {
  test("columns need keys", () => {
    expect(validateSavedViewColumns(null)).toBeNull()
    expect(validateSavedViewColumns([{ key: "name" }])).toBeNull()
    expect(validateSavedViewColumns([{ key: "" }])).not.toBeNull()
    expect(validateSavedViewColumns("name")).not.toBeNull()
  })

  test("sort needs field plus direction", () => {
    expect(validateSavedViewSort(null)).toBeNull()
    expect(validateSavedViewSort([{ field: "name", direction: "asc" }])).toBeNull()
    expect(validateSavedViewSort([{ field: "name", direction: "sideways" }])).not.toBeNull()
    expect(validateSavedViewSort([{ direction: "asc" }])).not.toBeNull()
  })
})

describe("saved-views/repository", () => {
  const input: { objectType: string; name: string; ownerId: string; filters: SavedViewFilterNode } =
    {
      objectType: "person",
      name: "My hot leads",
      ownerId: OWNER,
      filters: {
        op: "and",
        conditions: [{ field: "status", operator: "eq", value: "hot" }],
      },
    }

  test("create returns the inserted view", async () => {
    const repo = createSavedViewsRepository()
    const row = makeView()
    const result = await repo.create(mockDb([[row]]), WS, { ...input })
    expect(result).toBe(row)
  })

  test("create rejects invalid filter trees before touching the db", async () => {
    const repo = createSavedViewsRepository()
    await expect(
      repo.create(mockDb(), WS, {
        ...input,
        filters: { field: "status", operator: "eq" },
      }),
    ).rejects.toThrow("invalid filters")
  })

  test("create rejects empty names and bad sort", async () => {
    const repo = createSavedViewsRepository()
    await expect(repo.create(mockDb(), WS, { ...input, name: " " })).rejects.toThrow()
    await expect(
      repo.create(mockDb(), WS, {
        ...input,
        sort: [{ field: "x", direction: "up" }] as unknown as SavedView["sort"],
      }),
    ).rejects.toThrow("invalid sort")
  })

  test("listForOwner returns own plus shared views", async () => {
    const repo = createSavedViewsRepository()
    const rows = [makeView(), makeView({ id: "shared-1", ownerId: null, isShared: true })]
    expect(await repo.listForOwner(mockDb([rows]), WS, "person", OWNER)).toEqual(rows)
  })

  test("update returns the patched view or null", async () => {
    const repo = createSavedViewsRepository()
    const row = makeView({ name: "Renamed" })
    expect(await repo.update(mockDb([[row]]), WS, row.id, { name: "Renamed" })).toBe(row)
    expect(await repo.update(mockDb([[]]), WS, row.id, { name: "Renamed" })).toBeNull()
  })

  test("update validates replacement filters", async () => {
    const repo = createSavedViewsRepository()
    await expect(
      repo.update(mockDb(), WS, "view-1", {
        filters: { op: "and", conditions: [] },
      }),
    ).rejects.toThrow("invalid filters")
  })
})

describe("saved-views/migration", () => {
  test("0003 creates saved_views with the agreed columns and indexes", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS saved_views")
    expect(sql).toContain("owner_id UUID")
    expect(sql).toContain("object_type VARCHAR(64) NOT NULL")
    expect(sql).toContain("is_shared BOOLEAN NOT NULL DEFAULT FALSE")
    expect(sql).toContain("filter JSONB")
    expect(sql).toContain("columns JSONB")
    expect(sql).toContain("sort JSONB")
    expect(sql).toContain("saved_views_workspace_object_idx")
    expect(sql).toContain("ON saved_views (workspace_id, object_type)")
    expect(sql).toContain("saved_views_owner_idx")
  })
})
