import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { createBaseRepository } from "./base-repository"
import { relationships, type Relationship } from "../schema/relationships"
import { createRelationshipsRepository } from "./relationships-repository"

const WS = "11111111-1111-4111-8111-111111111111"
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

function makeRelationship(overrides: Partial<Relationship> = {}): Relationship {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    sourceType: "person",
    sourceId: "11111111-1111-4111-8111-111111111111",
    targetType: "deal",
    targetId: "22222222-2222-4222-8222-222222222222",
    relationshipType: "involved-in",
    label: null,
    metadata: null,
    ...overrides,
  }
}

// Compile-time proof: relationships satisfy the BaseTable contract.
createBaseRepository(relationships)

describe("relationships/schema", () => {
  test("edges expose the BaseRecord column contract", () => {
    const cols = relationships as unknown as Record<string, unknown>
    for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
      expect(cols[col], col).toBeDefined()
    }
    for (const col of ["sourceType", "sourceId", "targetType", "targetId", "relationshipType"]) {
      expect(cols[col], col).toBeDefined()
    }
    expect(cols.label).toBeDefined()
    expect(cols.metadata).toBeDefined()
  })
})

describe("relationships/repository", () => {
  const input = {
    sourceType: "person",
    sourceId: "11111111-1111-4111-8111-111111111111",
    targetType: "deal",
    targetId: "22222222-2222-4222-8222-222222222222",
    relationshipType: "involved-in",
  }

  test("create returns the inserted edge", async () => {
    const repo = createRelationshipsRepository()
    const row = makeRelationship()
    const result = await repo.create(mockDb([[row]]), WS, input)
    expect(result).toBe(row)
  })

  test("create rejects self-links", async () => {
    const repo = createRelationshipsRepository()
    await expect(
      repo.create(mockDb(), WS, {
        ...input,
        targetType: "person",
        targetId: input.sourceId,
      }),
    ).rejects.toThrow("itself")
  })

  test("create rejects empty endpoint/type fields", async () => {
    const repo = createRelationshipsRepository()
    await expect(repo.create(mockDb(), WS, { ...input, relationshipType: " " })).rejects.toThrow()
  })

  test("create surfaces empty insert results as errors", async () => {
    const repo = createRelationshipsRepository()
    await expect(repo.create(mockDb([[]]), WS, input)).rejects.toThrow()
  })

  test("listForRecord returns edges in both directions", async () => {
    const repo = createRelationshipsRepository()
    const rows = [makeRelationship()]
    const result = await repo.listForRecord(mockDb([rows]), WS, "person", input.sourceId)
    expect(result).toEqual(rows)
  })

  test("findEdge returns the live edge or null", async () => {
    const repo = createRelationshipsRepository()
    const row = makeRelationship()
    const found = await repo.findEdge(
      mockDb([[row]]),
      WS,
      "person",
      input.sourceId,
      "deal",
      input.targetId,
      "involved-in",
    )
    expect(found).toBe(row)
    const missing = await repo.findEdge(
      mockDb([[]]),
      WS,
      "person",
      input.sourceId,
      "deal",
      input.targetId,
      "involved-in",
    )
    expect(missing).toBeNull()
  })

  test("softDelete from the base repository resolves", async () => {
    const repo = createRelationshipsRepository()
    await repo.softDelete(mockDb([[]]), WS, "edge-1", "actor-1")
    await repo.restore(mockDb([[]]), WS, "edge-1")
  })
})

describe("relationships/migration", () => {
  test("0003 creates relationships with endpoint indexes", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS relationships")
    expect(sql).toContain("relationships_source_idx")
    expect(sql).toContain("ON relationships (source_type, source_id)")
    expect(sql).toContain("ON relationships (target_type, target_id)")
    expect(sql).toContain("relationships_edge_uidx")
    expect(sql).toContain("label VARCHAR(255)")
    expect(sql).toContain("metadata JSONB")
  })

  test("endpoints stay FK-free", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const block = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS relationships"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS custom_field_definitions"),
    )
    expect(block).not.toContain("REFERENCES")
  })
})
