import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { createBaseRepository } from "./base-repository"
import {
  customFieldDefinitions,
  customFieldValues,
  CUSTOM_FIELD_TYPES,
  isCustomFieldType,
  type CustomFieldDefinition,
  type CustomFieldOptions,
  type CustomFieldValue,
} from "../schema/custom-fields"
import {
  createCustomFieldDefinitionsRepository,
  createCustomFieldValuesRepository,
  normalizeCustomFieldKey,
  validateCustomFieldValue,
} from "./custom-fields-repository"

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

function makeDefinition(overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    objectType: "person",
    key: "vip_level",
    label: "VIP level",
    fieldType: "select",
    options: ["gold", "silver"],
    required: false,
    displayOrder: 0,
    ...overrides,
  }
}

function makeValue(overrides: Partial<CustomFieldValue> = {}): CustomFieldValue {
  return {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    definitionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    recordId: "11111111-1111-4111-8111-111111111111",
    value: "gold",
    ...overrides,
  }
}

// Compile-time proof: custom-field tables satisfy the BaseTable contract.
createBaseRepository(customFieldDefinitions)
createBaseRepository(customFieldValues)

describe("custom-fields/schema", () => {
  test("definitions expose the expected columns", () => {
    const cols = customFieldDefinitions as unknown as Record<string, unknown>
    for (const col of ["id", "workspaceId", "objectType", "key", "label", "fieldType"]) {
      expect(cols[col], col).toBeDefined()
    }
    expect(cols.options).toBeDefined()
    expect(cols.required).toBeDefined()
    expect(cols.displayOrder).toBeDefined()
  })

  test("values expose definition, record and value columns", () => {
    const cols = customFieldValues as unknown as Record<string, unknown>
    expect(cols.definitionId).toBeDefined()
    expect(cols.recordId).toBeDefined()
    expect(cols.value).toBeDefined()
  })

  test("field type catalog matches the wave-1 scope", () => {
    expect([...CUSTOM_FIELD_TYPES]).toEqual([
      "text",
      "number",
      "date",
      "select",
      "multiselect",
      "boolean",
      "url",
      "email",
    ])
    expect(isCustomFieldType("select")).toBe(true)
    expect(isCustomFieldType("formula")).toBe(false)
    expect(isCustomFieldType(42)).toBe(false)
  })
})

describe("custom-fields/keys", () => {
  test("normalizes human labels to snake_case", () => {
    expect(normalizeCustomFieldKey("Annual Revenue")).toBe("annual_revenue")
    expect(normalizeCustomFieldKey("vip-level")).toBe("vip_level")
  })

  test("rejects invalid keys", () => {
    expect(() => normalizeCustomFieldKey("9lives")).toThrow()
    expect(() => normalizeCustomFieldKey("  ")).toThrow()
    expect(() => normalizeCustomFieldKey("has space!")).toThrow()
  })
})

describe("custom-fields/validation", () => {
  test("scalar types accept matching values and null", () => {
    expect(validateCustomFieldValue({ fieldType: "text", options: null }, "hi")).toBeNull()
    expect(validateCustomFieldValue({ fieldType: "text", options: null }, 3)).not.toBeNull()
    expect(validateCustomFieldValue({ fieldType: "number", options: null }, 3)).toBeNull()
    expect(validateCustomFieldValue({ fieldType: "number", options: null }, "3")).not.toBeNull()
    expect(validateCustomFieldValue({ fieldType: "boolean", options: null }, true)).toBeNull()
    expect(validateCustomFieldValue({ fieldType: "boolean", options: null }, "yes")).not.toBeNull()
    expect(validateCustomFieldValue({ fieldType: "date", options: null }, "2026-01-01")).toBeNull()
    expect(validateCustomFieldValue({ fieldType: "url", options: null }, 7)).not.toBeNull()
    expect(validateCustomFieldValue({ fieldType: "email", options: null }, null)).toBeNull()
  })

  test("select enforces the option list", () => {
    const def: { fieldType: string; options: CustomFieldOptions } = {
      fieldType: "select",
      options: ["gold", "silver"],
    }
    expect(validateCustomFieldValue(def, "gold")).toBeNull()
    expect(validateCustomFieldValue(def, "bronze")).not.toBeNull()
    expect(validateCustomFieldValue(def, ["gold"])).not.toBeNull()
    expect(validateCustomFieldValue({ fieldType: "select", options: null }, "anything")).toBeNull()
  })

  test("multiselect needs string arrays within the option list", () => {
    const def: { fieldType: string; options: CustomFieldOptions } = {
      fieldType: "multiselect",
      options: [{ value: "a" }, { value: "b" }],
    }
    expect(validateCustomFieldValue(def, ["a", "b"])).toBeNull()
    expect(validateCustomFieldValue(def, ["a", "z"])).not.toBeNull()
    expect(validateCustomFieldValue(def, "a")).not.toBeNull()
    expect(validateCustomFieldValue(def, [1])).not.toBeNull()
  })

  test("unknown field types fail closed", () => {
    expect(validateCustomFieldValue({ fieldType: "formula", options: null }, "x")).not.toBeNull()
  })
})

describe("custom-fields/definitions-repository", () => {
  const input = {
    objectType: "person",
    key: "vip_level",
    label: "VIP level",
    fieldType: "select",
    options: ["gold", "silver"],
  }

  test("create returns the inserted definition", async () => {
    const repo = createCustomFieldDefinitionsRepository()
    const row = makeDefinition()
    const result = await repo.create(mockDb([[row]]), WS, input)
    expect(result).toBe(row)
  })

  test("create rejects unknown types and option-less selects", async () => {
    const repo = createCustomFieldDefinitionsRepository()
    await expect(repo.create(mockDb(), WS, { ...input, fieldType: "formula" })).rejects.toThrow()
    await expect(
      repo.create(mockDb(), WS, { ...input, fieldType: "select", options: [] }),
    ).rejects.toThrow()
    await expect(repo.create(mockDb(), WS, { ...input, label: " " })).rejects.toThrow()
  })

  test("listByObject returns definitions in display order", async () => {
    const repo = createCustomFieldDefinitionsRepository()
    const rows = [makeDefinition()]
    expect(await repo.listByObject(mockDb([rows]), WS, "person")).toEqual(rows)
  })

  test("update returns the patched row or null", async () => {
    const repo = createCustomFieldDefinitionsRepository()
    const row = makeDefinition({ label: "Tier" })
    expect(await repo.update(mockDb([[row]]), WS, row.id, { label: "Tier" })).toBe(row)
    expect(await repo.update(mockDb([[]]), WS, row.id, { label: "Tier" })).toBeNull()
  })
})

describe("custom-fields/values-repository", () => {
  test("setValue reuses an existing row", async () => {
    const repo = createCustomFieldValuesRepository()
    const row = makeValue()
    const result = await repo.setValue(mockDb([[row]]), WS, row.definitionId, row.recordId, "gold")
    expect(result).toBe(row)
  })

  test("setValue inserts when no row exists", async () => {
    const repo = createCustomFieldValuesRepository()
    const row = makeValue()
    const result = await repo.setValue(
      mockDb([[], [row]]),
      WS,
      row.definitionId,
      row.recordId,
      "gold",
    )
    expect(result).toBe(row)
  })

  test("setValue surfaces races as errors", async () => {
    const repo = createCustomFieldValuesRepository()
    await expect(repo.setValue(mockDb([[], []]), WS, "def-1", "rec-1", "gold")).rejects.toThrow()
  })

  test("getValue returns the row or null", async () => {
    const repo = createCustomFieldValuesRepository()
    const row = makeValue()
    expect(await repo.getValue(mockDb([[row]]), WS, row.definitionId, row.recordId)).toBe(row)
    expect(await repo.getValue(mockDb([[]]), WS, row.definitionId, row.recordId)).toBeNull()
  })

  test("listForRecords short-circuits on empty input", async () => {
    const repo = createCustomFieldValuesRepository()
    await expect(repo.listForRecords(mockDb(), WS, [])).resolves.toEqual([])
  })

  test("listForRecords returns matching values", async () => {
    const repo = createCustomFieldValuesRepository()
    const rows = [makeValue()]
    expect(await repo.listForRecords(mockDb([rows]), WS, [rows[0]?.recordId ?? ""])).toEqual(rows)
  })
})

describe("custom-fields/migration", () => {
  test("0003 creates definitions and values with the agreed indexes", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS custom_field_definitions")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS custom_field_values")
    expect(sql).toContain("custom_field_definitions_workspace_object_key_uidx")
    expect(sql).toContain("ON custom_field_definitions (workspace_id, object_type, key)")
    expect(sql).toContain("custom_field_values_definition_record_uidx")
    expect(sql).toContain("REFERENCES custom_field_definitions (id) ON DELETE CASCADE")
    expect(sql).toContain("required BOOLEAN NOT NULL DEFAULT FALSE")
    expect(sql).toContain("display_order INTEGER NOT NULL DEFAULT 0")
  })

  test("value record references stay FK-free", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const block = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS custom_field_values"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS saved_views"),
    )
    expect(block).toContain("record_id UUID NOT NULL")
    expect(block).not.toContain("REFERENCES people")
  })
})
