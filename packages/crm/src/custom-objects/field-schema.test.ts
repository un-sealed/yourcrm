import { describe, expect, test } from "bun:test"
import { CustomObjectValidationError } from "./errors"
import {
  applyCustomObjectFieldDefaults,
  buildCustomObjectRecordSchema,
  customObjectOptionValues,
  deriveCustomObjectDisplayName,
  isCustomObjectFieldType,
  mergeCustomObjectRecordValues,
  parseCustomObjectRecordValues,
  type CustomObjectFieldDefinitionLike,
} from "./field-schema"
import {
  CUSTOM_OBJECT_RESERVED_SLUGS,
  isValidCustomObjectSlug,
  parseCustomObjectFieldKey,
  parseCustomObjectSlug,
} from "./naming"

function field(
  overrides: Partial<CustomObjectFieldDefinitionLike> & { key: string; fieldType: string },
): CustomObjectFieldDefinitionLike {
  return {
    label: overrides.key,
    required: false,
    displayOrder: 0,
    options: null,
    defaultValue: null,
    ...overrides,
  }
}

const TEXT = field({ key: "title", fieldType: "text", label: "Title", required: true })
const NUMBER = field({ key: "seats", fieldType: "number", label: "Seats" })
const SELECT = field({
  key: "tier",
  fieldType: "select",
  label: "Tier",
  options: ["gold", "silver"],
})

describe("custom-objects/naming", () => {
  test("accepts lowercase slugs with single separators", () => {
    expect(parseCustomObjectSlug("  Deal-Room ")).toBe("deal-room")
    expect(parseCustomObjectSlug("site_visit")).toBe("site_visit")
  })

  test("rejects slugs outside the allowlist pattern", () => {
    for (const bad of [
      "a",
      "1room",
      "Deal Room",
      "deal--room",
      "deal-",
      "deal/room",
      "deal;drop",
      "../etc",
      "deal.room",
      "x".repeat(65),
    ]) {
      expect(() => parseCustomObjectSlug(bad), bad).toThrow(CustomObjectValidationError)
    }
  })

  test("rejects reserved slugs so a custom object cannot shadow a built-in one", () => {
    // Fields of built-in and custom objects share custom_field_definitions,
    // keyed by object_type; a slug of "person" would hijack the built-ins.
    expect(() => parseCustomObjectSlug("person")).toThrow(/reserved/)
    expect(() => parseCustomObjectSlug("deals")).toThrow(/reserved/)
    expect(() => parseCustomObjectSlug("records")).toThrow(/reserved/)
    expect(() => parseCustomObjectSlug("__proto__")).toThrow()
    expect(CUSTOM_OBJECT_RESERVED_SLUGS).toContain("person")
  })

  test("isValidCustomObjectSlug mirrors the parser without throwing", () => {
    expect(isValidCustomObjectSlug("deal-room")).toBe(true)
    expect(isValidCustomObjectSlug("person")).toBe(false)
  })

  test("field keys normalize to snake_case and reject hazards", () => {
    expect(parseCustomObjectFieldKey(" Renewal Date ")).toBe("renewal_date")
    // Caught by the leading-letter rule before the reserved list even runs.
    expect(() => parseCustomObjectFieldKey("__proto__")).toThrow(CustomObjectValidationError)
    expect(() => parseCustomObjectFieldKey("constructor")).toThrow(/reserved/)
    expect(() => parseCustomObjectFieldKey("id")).toThrow(/reserved/)
    expect(() => parseCustomObjectFieldKey("display_name")).toThrow(/reserved/)
    expect(() => parseCustomObjectFieldKey("9lives")).toThrow()
    expect(() => parseCustomObjectFieldKey("x'; DROP TABLE people;--")).toThrow()
    expect(() => parseCustomObjectFieldKey("a.b")).toThrow()
    expect(() => parseCustomObjectFieldKey("x".repeat(129))).toThrow()
  })
})

describe("custom-objects/schema-builder", () => {
  test("knows exactly the P0 field types", () => {
    for (const type of [
      "text",
      "number",
      "date",
      "select",
      "multiselect",
      "boolean",
      "url",
      "email",
    ]) {
      expect(isCustomObjectFieldType(type), type).toBe(true)
    }
    expect(isCustomObjectFieldType("currency")).toBe(false)
  })

  test("validates each type against its own rules", () => {
    const definitions = [
      field({ key: "name", fieldType: "text" }),
      field({ key: "count", fieldType: "number" }),
      field({ key: "due", fieldType: "date" }),
      field({ key: "live", fieldType: "boolean" }),
      field({ key: "site", fieldType: "url" }),
      field({ key: "contact", fieldType: "email" }),
      field({ key: "tier", fieldType: "select", options: ["gold"] }),
      field({ key: "tags", fieldType: "multiselect", options: ["a", "b"] }),
    ]
    const ok = parseCustomObjectRecordValues(definitions, {
      name: "Acme",
      count: 3,
      due: "2026-01-02",
      live: true,
      site: "https://example.com",
      contact: "ada@example.com",
      tier: "gold",
      tags: ["a", "b"],
    })
    expect(ok.name).toBe("Acme")
    expect(ok.tags).toEqual(["a", "b"])

    expect(() => parseCustomObjectRecordValues(definitions, { count: "3" })).toThrow(
      CustomObjectValidationError,
    )
    expect(() => parseCustomObjectRecordValues(definitions, { live: "yes" })).toThrow()
    expect(() => parseCustomObjectRecordValues(definitions, { site: "not-a-url" })).toThrow()
    expect(() => parseCustomObjectRecordValues(definitions, { contact: "nope" })).toThrow()
    expect(() => parseCustomObjectRecordValues(definitions, { due: "never" })).toThrow()
    expect(() => parseCustomObjectRecordValues(definitions, { tier: "bronze" })).toThrow()
    expect(() => parseCustomObjectRecordValues(definitions, { tags: ["a", "z"] })).toThrow()
  })

  test("required fields must be present and may not be null", () => {
    expect(() => parseCustomObjectRecordValues([TEXT], {})).toThrow(CustomObjectValidationError)
    expect(() => parseCustomObjectRecordValues([TEXT], { title: null })).toThrow()
    expect(() => parseCustomObjectRecordValues([TEXT], { title: "   " })).toThrow()
    expect(parseCustomObjectRecordValues([TEXT], { title: "Ready" }).title).toBe("Ready")
  })

  test("required fields may be omitted in patch mode but never nulled", () => {
    expect(parseCustomObjectRecordValues([TEXT, NUMBER], { seats: 2 }, { partial: true })).toEqual({
      seats: 2,
    })
    expect(() =>
      parseCustomObjectRecordValues([TEXT], { title: null }, { partial: true }),
    ).toThrow()
  })

  test("optional fields accept null so a value can be cleared", () => {
    expect(parseCustomObjectRecordValues([NUMBER], { seats: null })).toEqual({ seats: null })
  })

  test("unknown keys are rejected — the jsonb payload is closed", () => {
    expect(() => parseCustomObjectRecordValues([NUMBER], { seats: 1, rogue: "x" })).toThrow(
      CustomObjectValidationError,
    )
  })

  test("a __proto__ key from JSON.parse cannot reach the payload", () => {
    const hostile: unknown = JSON.parse('{"seats": 1, "__proto__": {"admin": true}}')
    expect(() => parseCustomObjectRecordValues([NUMBER], hostile)).toThrow()
    // And nothing leaked onto Object.prototype along the way.
    expect(({} as Record<string, unknown>).admin).toBeUndefined()
  })

  test("non-object payloads are rejected", () => {
    expect(() => parseCustomObjectRecordValues([NUMBER], [1, 2])).toThrow(/JSON object/)
    expect(() => parseCustomObjectRecordValues([NUMBER], null)).toThrow(/JSON object/)
    expect(() => parseCustomObjectRecordValues([NUMBER], "seats=1")).toThrow(/JSON object/)
  })

  test("the builder FAILS CLOSED on definitions it cannot police", () => {
    // Unknown type: skipping the field would make it accept anything.
    expect(() =>
      buildCustomObjectRecordSchema([field({ key: "x", fieldType: "currency" })]),
    ).toThrow(/unsupported type/)
    // Select with no options has no allowed set at all.
    expect(() => buildCustomObjectRecordSchema([field({ key: "t", fieldType: "select" })])).toThrow(
      /no options/,
    )
    // A definition whose key escaped validation must not become a schema.
    expect(() =>
      buildCustomObjectRecordSchema([field({ key: "__proto__", fieldType: "text" })]),
    ).toThrow()
    expect(() =>
      buildCustomObjectRecordSchema([field({ key: "Bad Key", fieldType: "text" })]),
    ).toThrow(/unusable key/)
    // Duplicate keys would silently shadow one another.
    expect(() => buildCustomObjectRecordSchema([NUMBER, NUMBER])).toThrow(/duplicate/)
  })

  test("defaults fill missing keys and are themselves validated", () => {
    const withDefault = field({ key: "tier", fieldType: "select", options: ["gold"] })
    withDefault.defaultValue = "gold"
    expect(applyCustomObjectFieldDefaults([withDefault], {})).toEqual({ tier: "gold" })
    expect(parseCustomObjectRecordValues([withDefault], {})).toEqual({ tier: "gold" })
    // Supplied values win over the default.
    expect(parseCustomObjectRecordValues([withDefault], { tier: "gold" })).toEqual({ tier: "gold" })
    // A default that does not satisfy its own field is caught like any value.
    const badDefault = field({ key: "seats", fieldType: "number" })
    badDefault.defaultValue = "many"
    expect(() => parseCustomObjectRecordValues([badDefault], {})).toThrow(
      CustomObjectValidationError,
    )
  })

  test("option values read both option spellings", () => {
    expect(customObjectOptionValues(["a", { value: "b", label: "B" }])).toEqual(["a", "b"])
    expect(customObjectOptionValues(null)).toBeNull()
  })
})

describe("custom-objects/merge", () => {
  test("merging keeps values whose definition is gone", () => {
    const stored = { title: "Acme", legacy_notes: "kept" }
    const merged = mergeCustomObjectRecordValues(stored, { title: "Acme II" })
    expect(merged).toEqual({ title: "Acme II", legacy_notes: "kept" })
  })

  test("an explicit null clears exactly one key", () => {
    const merged = mergeCustomObjectRecordValues({ a: 1, b: 2 }, { b: null })
    expect(merged).toEqual({ a: 1 })
  })
})

describe("custom-objects/display-name", () => {
  test("uses the first non-empty string field in display order", () => {
    const definitions = [
      field({ key: "code", fieldType: "text", displayOrder: 1 }),
      field({ key: "name", fieldType: "text", displayOrder: 0 }),
    ]
    expect(deriveCustomObjectDisplayName(definitions, { name: "Acme", code: "A-1" })).toBe("Acme")
    expect(deriveCustomObjectDisplayName(definitions, { code: "A-1" })).toBe("A-1")
  })

  test("falls back when nothing readable is stored", () => {
    expect(deriveCustomObjectDisplayName([SELECT], {})).toBe("Untitled")
    expect(deriveCustomObjectDisplayName([SELECT], { tier: "   " })).toBe("Untitled")
  })

  test("never exceeds the display_name column length", () => {
    const definitions = [field({ key: "name", fieldType: "text" })]
    const long = deriveCustomObjectDisplayName(definitions, { name: "x".repeat(400) })
    expect(long).toHaveLength(255)
  })
})
