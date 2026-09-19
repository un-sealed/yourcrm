import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import {
  customObjectDefinitions,
  customObjectRecords,
  type CustomObjectDefinition,
  type CustomObjectRecord,
} from "../schema/custom-objects"
import { customFieldDefinitions } from "../schema/custom-fields"
import { createBaseRepository } from "./base-repository"
import {
  CUSTOM_OBJECT_UNSAFE_FIELD_KEYS,
  assertSafeCustomObjectFieldValues,
  createCustomObjectsRepository,
  normalizeCustomObjectLabel,
  normalizeCustomObjectRecordDisplayName,
  normalizeCustomObjectSlug,
} from "./custom-objects-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const OBJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const RECORD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const MIGRATION = new URL("../../migrations/0200_custom_objects.sql", import.meta.url)
const SHARED_MIGRATION = new URL("../../migrations/0003_shared_tables.sql", import.meta.url)

/** Thenable chain stub: every builder call returns the proxy; each await pops one result. */
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

function makeObject(overrides: Partial<CustomObjectDefinition> = {}): CustomObjectDefinition {
  return {
    id: OBJECT_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    slug: "deal-room",
    name: "Deal room",
    pluralName: "Deal rooms",
    icon: null,
    description: null,
    ...overrides,
  }
}

function makeRecord(overrides: Partial<CustomObjectRecord> = {}): CustomObjectRecord {
  return {
    id: RECORD_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ownerId: null,
    objectId: OBJECT_ID,
    displayName: "Acme",
    fieldValues: { title: "Acme" },
    ...overrides,
  }
}

// Compile-time proof: both tables satisfy the shared BaseTable contract.
createBaseRepository(customObjectDefinitions)
createBaseRepository(customObjectRecords)

describe("custom-objects/schema", () => {
  test("definitions expose the base columns plus slug, name and plural", () => {
    const cols = customObjectDefinitions as unknown as Record<string, unknown>
    for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
      expect(cols[col], col).toBeDefined()
    }
    expect(cols.slug).toBeDefined()
    expect(cols.name).toBeDefined()
    expect(cols.pluralName).toBeDefined()
    expect(cols.icon).toBeDefined()
    expect(cols.description).toBeDefined()
  })

  test("records carry the object FK, owner, display name and jsonb payload", () => {
    const cols = customObjectRecords as unknown as Record<string, unknown>
    expect(cols.objectId).toBeDefined()
    expect(cols.ownerId).toBeDefined()
    expect(cols.displayName).toBeDefined()
    expect(cols.fieldValues).toBeDefined()
    // "values" is a reserved word in Postgres; the column must not use it.
    expect(cols.values).toBeUndefined()
  })

  test("the existing field catalog gains default_value and keeps every column", () => {
    const cols = customFieldDefinitions as unknown as Record<string, unknown>
    for (const col of ["objectType", "key", "label", "fieldType", "options", "required"]) {
      expect(cols[col], col).toBeDefined()
    }
    expect(cols.displayOrder).toBeDefined()
    expect(cols.defaultValue).toBeDefined()
  })
})

describe("custom-objects/validation", () => {
  test("slugs lowercase, trim and match the allowlist", () => {
    expect(normalizeCustomObjectSlug("  Deal-Room ")).toBe("deal-room")
    expect(normalizeCustomObjectSlug("site_visit_2")).toBe("site_visit_2")
  })

  test("slugs outside the allowlist are rejected, never sanitized", () => {
    for (const bad of ["a", "1x", "deal room", "deal--room", "deal-", "x/y", "x;y", "../etc"]) {
      expect(() => normalizeCustomObjectSlug(bad), bad).toThrow()
    }
    expect(() => normalizeCustomObjectSlug("x".repeat(65))).toThrow()
  })

  test("labels trim, collapse whitespace and respect the column length", () => {
    expect(normalizeCustomObjectLabel("  Deal   Room ", "name")).toBe("Deal Room")
    expect(() => normalizeCustomObjectLabel("   ", "name")).toThrow()
    expect(() => normalizeCustomObjectLabel("x".repeat(129), "name")).toThrow()
  })

  test("display names never exceed the column and never go blank", () => {
    expect(normalizeCustomObjectRecordDisplayName("   ")).toBe("Untitled")
    expect(normalizeCustomObjectRecordDisplayName("x".repeat(400))).toHaveLength(255)
  })

  test("payload keys are allowlisted, so column shadowing and pollution fail", () => {
    expect(assertSafeCustomObjectFieldValues({ title: "Acme" })).toEqual({ title: "Acme" })
    for (const key of CUSTOM_OBJECT_UNSAFE_FIELD_KEYS) {
      expect(() => assertSafeCustomObjectFieldValues({ [key]: 1 }), key).toThrow()
    }
    expect(() => assertSafeCustomObjectFieldValues({ "Bad Key": 1 })).toThrow()
    expect(() => assertSafeCustomObjectFieldValues({ "x'; DROP TABLE y--": 1 })).toThrow()
    expect(() => assertSafeCustomObjectFieldValues([1, 2])).toThrow(/JSON object/)
    expect(() => assertSafeCustomObjectFieldValues(null)).toThrow(/JSON object/)
  })

  test("a JSON.parse __proto__ key is rejected and nothing leaks", () => {
    const hostile: unknown = JSON.parse('{"title":"A","__proto__":{"polluted":true}}')
    expect(() => assertSafeCustomObjectFieldValues(hostile)).toThrow(/reserved/)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe("custom-objects/repository", () => {
  test("createObject returns the inserted definition", async () => {
    const repo = createCustomObjectsRepository()
    const row = makeObject()
    const created = await repo.createObject(mockDb([[row]]), WS, {
      slug: "deal-room",
      name: "Deal room",
      pluralName: "Deal rooms",
    })
    expect(created).toBe(row)
  })

  test("createObject rejects a bad slug before touching the db", async () => {
    const repo = createCustomObjectsRepository()
    await expect(
      repo.createObject(mockDb(), WS, { slug: "Deal Room", name: "X", pluralName: "Xs" }),
    ).rejects.toThrow()
  })

  test("createObject surfaces empty insert results as errors", async () => {
    const repo = createCustomObjectsRepository()
    await expect(
      repo.createObject(mockDb([[]]), WS, { slug: "deal-room", name: "X", pluralName: "Xs" }),
    ).rejects.toThrow()
  })

  test("searchObjects returns the cursor pagination envelope", async () => {
    const repo = createCustomObjectsRepository()
    const rows = [
      makeObject({ id: "id-1" }),
      makeObject({ id: "id-2" }),
      makeObject({ id: "id-3" }),
    ]
    const result = await repo.searchObjects(mockDb([rows]), { workspaceId: WS, limit: 2 })
    expect(result.data).toHaveLength(2)
    expect(result.pagination).toEqual({ nextCursor: "id-2", limit: 2 })
  })

  test("findObjectBySlug validates the slug before querying", async () => {
    const repo = createCustomObjectsRepository()
    await expect(repo.findObjectBySlug(mockDb(), WS, "Deal Room")).rejects.toThrow()
    await expect(repo.findObjectBySlug(mockDb([[]]), WS, "deal-room")).resolves.toBeNull()
  })

  test("updateObject cannot change the slug and returns null when missing", async () => {
    const repo = createCustomObjectsRepository()
    await expect(repo.updateObject(mockDb([[]]), WS, OBJECT_ID, { name: "X" })).resolves.toBeNull()
    const patched = makeObject({ name: "Renamed" })
    const result = await repo.updateObject(mockDb([[patched]]), WS, OBJECT_ID, { name: "Renamed" })
    // The input type has no `slug`, so there is no code path that writes one.
    expect(result?.slug).toBe("deal-room")
  })

  test("createRecord rejects an unsafe payload before the insert", async () => {
    const repo = createCustomObjectsRepository()
    await expect(
      repo.createRecord(mockDb(), WS, {
        objectId: OBJECT_ID,
        displayName: "Acme",
        fieldValues: { display_name: "hijack" },
      }),
    ).rejects.toThrow(/reserved/)
  })

  test("createRecord stores the validated payload", async () => {
    const repo = createCustomObjectsRepository()
    const row = makeRecord()
    const created = await repo.createRecord(mockDb([[row]]), WS, {
      objectId: OBJECT_ID,
      displayName: "Acme",
      fieldValues: { title: "Acme" },
    })
    expect(created).toBe(row)
  })

  test("searchRecords paginates and rejects unsafe filter keys", async () => {
    const repo = createCustomObjectsRepository()
    const rows = [makeRecord({ id: "r1" }), makeRecord({ id: "r2" }), makeRecord({ id: "r3" })]
    const result = await repo.searchRecords(mockDb([rows]), {
      workspaceId: WS,
      objectId: OBJECT_ID,
      limit: 2,
      query: "acme",
      match: { title: "Acme" },
    })
    expect(result.data).toHaveLength(2)
    expect(result.pagination).toEqual({ nextCursor: "r2", limit: 2 })
    await expect(
      repo.searchRecords(mockDb(), {
        workspaceId: WS,
        objectId: OBJECT_ID,
        match: { "title'; DROP TABLE x--": "y" },
      }),
    ).rejects.toThrow()
  })

  test("updateRecord returns null when the row is missing", async () => {
    const repo = createCustomObjectsRepository()
    await expect(
      repo.updateRecord(mockDb([[]]), WS, OBJECT_ID, "missing", { displayName: "X" }),
    ).resolves.toBeNull()
  })

  test("findRecordById scopes by object and returns null when missing", async () => {
    const repo = createCustomObjectsRepository()
    await expect(
      repo.findRecordById(mockDb([[]]), WS, OBJECT_ID, "missing"),
    ).resolves.toBeNull()
    const row = makeRecord()
    await expect(repo.findRecordById(mockDb([[row]]), WS, OBJECT_ID, RECORD_ID)).resolves.toBe(row)
  })
})

describe("custom-objects/migration", () => {
  test("0200 creates both tables with the agreed indexes and constraints", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS custom_object_definitions")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS custom_object_records")
    expect(sql).toContain("custom_object_definitions_workspace_slug_uidx")
    expect(sql).toContain("REFERENCES custom_object_definitions (id) ON DELETE CASCADE")
    expect(sql).toContain("USING GIN (field_values)")
    expect(sql).toContain("custom_object_definitions_slug_format")
  })

  test("0200 EXTENDS the shared custom-field tables instead of redefining them", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    // Exactly one additive, nullable column on the wave-1 catalog...
    expect(sql).toContain("ALTER TABLE custom_field_definitions")
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS default_value JSONB")
    // ...and nothing destructive anywhere in the file.
    expect(sql).not.toMatch(/DROP\s+TABLE(?![^\n]*IF EXISTS custom_object)/i)
    expect(sql).not.toMatch(/DROP\s+COLUMN(?!\s+IF EXISTS default_value)/i)
    expect(sql).not.toMatch(/CREATE TABLE[^\n]*custom_field_(definitions|values)/i)
  })

  test("the shared custom_field_values contract is left untouched", async () => {
    const shared = await readFile(SHARED_MIGRATION, "utf8")
    const mine = await readFile(MIGRATION, "utf8")
    // Built-in objects keep attaching custom fields by (object_type, record_id).
    expect(shared).toContain("CREATE TABLE IF NOT EXISTS custom_field_values")
    const statements = mine
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
    expect(statements).not.toContain("custom_field_values")
  })

  test("no foreign key is added to a table this module does not own", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const references = [...sql.matchAll(/REFERENCES\s+([a-z_]+)/gi)].map((match) => match[1])
    expect(references).toEqual(["custom_object_definitions"])
  })

  test("the migration issues no runtime-shaped DDL helpers", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    // Sanity: the module's only DDL is this reviewed file, no EXECUTE/DO blocks.
    expect(sql).not.toMatch(/\bEXECUTE\b/i)
    expect(sql).not.toMatch(/\bDO\s+\$\$/i)
  })
})
