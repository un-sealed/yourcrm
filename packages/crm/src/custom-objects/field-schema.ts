import { z } from "zod"
import { CustomObjectValidationError } from "./errors"
import { CUSTOM_OBJECT_FIELD_KEY_RE, CUSTOM_OBJECT_RESERVED_FIELD_KEYS } from "./naming"

/**
 * RUNTIME SCHEMA CONSTRUCTION — the technical core of the module.
 *
 * A custom object has no table and no compile-time type. The only thing
 * standing between a user-authored field definition and the jsonb column is
 * the zod schema built here from that definition set, once per write.
 *
 * Two rules shape every decision below:
 *
 *  1. FAIL CLOSED. If a definition cannot be turned into a schema — unknown
 *     field type, unsafe key, a select with no options, a duplicate key —
 *     the build THROWS instead of skipping the field. Skipping would mean
 *     the field silently accepts anything, which is precisely how a bad
 *     definition becomes a data-integrity incident. A broken definition
 *     blocks writes to that object until an admin fixes it; reads keep
 *     working, so nothing already stored is lost.
 *
 *  2. STRICT OBJECTS. The generated schema is `.strict()`, so a payload may
 *     only contain keys that correspond to a live field definition. That is
 *     what stops callers inventing jsonb keys — including `__proto__`,
 *     which `JSON.parse` happily materializes as an own property.
 *
 * Nothing here uses `any`: values arrive as `unknown` and are narrowed by
 * zod, which is the only narrowing the engine trusts.
 */

/** Field types this engine can store and validate (spec 33 P0 set). */
export const CUSTOM_OBJECT_FIELD_TYPES = [
  "text",
  "number",
  "date",
  "select",
  "multiselect",
  "boolean",
  "url",
  "email",
] as const

export type CustomObjectFieldType = (typeof CUSTOM_OBJECT_FIELD_TYPES)[number]

export function isCustomObjectFieldType(value: unknown): value is CustomObjectFieldType {
  return (
    typeof value === "string" && (CUSTOM_OBJECT_FIELD_TYPES as readonly string[]).includes(value)
  )
}

/** A select option: a bare value, or a value with a display label. */
export type CustomObjectFieldOption = string | { value: string; label?: string | undefined }

/**
 * The shape the engine needs from a field definition. Structural on
 * purpose: a drizzle `CustomFieldDefinition` row satisfies it, and so does
 * a plain literal in a test — `@yourcrm/crm` never imports the database.
 */
export type CustomObjectFieldDefinitionLike = {
  key: string
  label: string
  fieldType: string
  required: boolean
  displayOrder?: number | undefined
  options?: readonly CustomObjectFieldOption[] | null | undefined
  defaultValue?: unknown
}

export type BuildCustomObjectRecordSchemaOptions = {
  /**
   * Patch mode: every field becomes optional, so a PATCH may carry a
   * subset. Required fields still may not be set to null — optional means
   * "not mentioned", not "allowed to be blank".
   */
  partial?: boolean | undefined
}

/** Option values of a select/multiselect definition, or null when unset. */
export function customObjectOptionValues(
  options: readonly CustomObjectFieldOption[] | null | undefined,
): string[] | null {
  if (!options) return null
  return options.map((option) => (typeof option === "string" ? option : option.value))
}

function assertUsableKey(key: string, label: string): void {
  if (!CUSTOM_OBJECT_FIELD_KEY_RE.test(key) || key.length > 128) {
    throw new CustomObjectValidationError(
      `field "${label}" has an unusable key "${key}"; definitions must be repaired before writing`,
    )
  }
  if (CUSTOM_OBJECT_RESERVED_FIELD_KEYS.includes(key)) {
    throw new CustomObjectValidationError(`field "${label}" uses the reserved key "${key}"`)
  }
}

function baseSchemaFor(definition: CustomObjectFieldDefinitionLike): z.ZodTypeAny {
  const { fieldType, label, required } = definition
  switch (fieldType) {
    case "text":
      return required ? z.string().trim().min(1).max(10_000) : z.string().trim().max(10_000)
    case "number":
      return z
        .number()
        .refine((value) => Number.isFinite(value), { message: `${label} must be a finite number` })
    case "boolean":
      return z.boolean()
    case "url":
      return z.string().trim().url().max(2048)
    case "email":
      return z.string().trim().email().max(320)
    case "date":
      // Stored as an ISO string: jsonb has no date type, and a string keeps
      // the value round-trippable through the API without a lossy parse.
      return z
        .string()
        .trim()
        .min(1)
        .max(64)
        .refine((value) => !Number.isNaN(Date.parse(value)), {
          message: `${label} must be an ISO date`,
        })
    case "select": {
      const allowed = customObjectOptionValues(definition.options)
      if (!allowed || allowed.length === 0) {
        throw new CustomObjectValidationError(`select field "${label}" has no options`)
      }
      return z.string().refine((value) => allowed.includes(value), {
        message: `${label} must be one of: ${allowed.join(", ")}`,
      })
    }
    case "multiselect": {
      const allowed = customObjectOptionValues(definition.options)
      if (!allowed || allowed.length === 0) {
        throw new CustomObjectValidationError(`multiselect field "${label}" has no options`)
      }
      const array = required ? z.array(z.string()).min(1).max(200) : z.array(z.string()).max(200)
      return array.refine((values) => values.every((value) => allowed.includes(value)), {
        message: `${label} may only contain: ${allowed.join(", ")}`,
      })
    }
    default:
      // FAIL CLOSED: an unknown type is a definition this engine cannot
      // police, so it refuses to police anything on this object.
      throw new CustomObjectValidationError(
        `field "${label}" has unsupported type "${String(fieldType)}"`,
      )
  }
}

/**
 * Build a zod schema for one object's record payload from its live field
 * definitions. Throws `CustomObjectValidationError` when the definition set
 * itself is unusable (see the fail-closed rule above).
 */
export function buildCustomObjectRecordSchema(
  definitions: readonly CustomObjectFieldDefinitionLike[],
  options: BuildCustomObjectRecordSchemaOptions = {},
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const definition of definitions) {
    const key = definition.key
    assertUsableKey(key, definition.label)
    if (Object.prototype.hasOwnProperty.call(shape, key)) {
      throw new CustomObjectValidationError(`duplicate field key "${key}"`)
    }
    const schema: z.ZodTypeAny = baseSchemaFor(definition)
    if (definition.required) {
      // Required fields are never nullable: "required" would mean nothing
      // if `null` satisfied it. In patch mode they may simply be omitted.
      shape[key] = options.partial === true ? schema.optional() : schema
    } else {
      shape[key] = schema.nullish()
    }
  }
  // `.strict()`: unknown keys are an error, not a silent passthrough. This
  // is the single line that keeps arbitrary user keys out of the jsonb.
  return z.object(shape).strict()
}

/** Plain JSON object guard — arrays and null are not record payloads. */
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Copy entries onto a fresh object with `defineProperty`, so no setter
 * reachable through the prototype chain can observe or intercept the write.
 */
function toSafeObject(entries: Iterable<[string, unknown]>): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    Object.defineProperty(safe, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return safe
}

/**
 * Fill in definition defaults for keys the caller did not supply. Defaults
 * are applied BEFORE validation, never after: a default that does not match
 * its own field type must be caught like any other bad value.
 */
export function applyCustomObjectFieldDefaults(
  definitions: readonly CustomObjectFieldDefinitionLike[],
  input: Record<string, unknown>,
): Record<string, unknown> {
  const entries: [string, unknown][] = Object.entries(input)
  const supplied = new Set(entries.map(([key]) => key))
  for (const definition of definitions) {
    if (supplied.has(definition.key)) continue
    const fallback = definition.defaultValue
    if (fallback === undefined || fallback === null) continue
    entries.push([definition.key, fallback])
  }
  return toSafeObject(entries)
}

/**
 * Validate a payload against the live definitions and return a clean object
 * containing only defined fields.
 *
 * `partial` mode is what makes a soft-deleted field safe: the service
 * validates only the incoming patch and merges it over the stored payload,
 * so values belonging to fields that no longer have a live definition are
 * carried through untouched instead of being validated (and rejected) or
 * dropped.
 */
export function parseCustomObjectRecordValues(
  definitions: readonly CustomObjectFieldDefinitionLike[],
  raw: unknown,
  options: BuildCustomObjectRecordSchemaOptions = {},
): Record<string, unknown> {
  if (!isPlainJsonObject(raw)) {
    throw new CustomObjectValidationError("values must be a JSON object")
  }
  const schema = buildCustomObjectRecordSchema(definitions, options)
  const withDefaults =
    options.partial === true ? raw : applyCustomObjectFieldDefaults(definitions, raw)
  const result = schema.safeParse(withDefaults)
  if (!result.success) {
    throw new CustomObjectValidationError(
      "record does not satisfy the field definitions",
      result.error.flatten(),
    )
  }
  // Drop keys the caller explicitly cleared so the stored payload stays
  // compact, and rebuild defensively rather than reusing zod's output.
  const entries = Object.entries(result.data).filter(([, value]) => value !== undefined)
  return toSafeObject(entries)
}

/**
 * Merge a validated patch over a stored payload. Keys already stored for
 * fields that no longer have a live definition survive: deleting a field
 * definition hides a field, it does not destroy the data behind it.
 * `null` in the patch clears that one key.
 */
export function mergeCustomObjectRecordValues(
  stored: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = new Map<string, unknown>(Object.entries(stored))
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) merged.delete(key)
    else merged.set(key, value)
  }
  return toSafeObject(merged)
}

/**
 * Human-readable title for a record: the value of the first field, in
 * display order, that holds a non-empty string. Denormalized onto
 * `custom_object_records.display_name` so lists and headers never have to
 * crack the jsonb, and so the acceptance criterion "usable without
 * knowledge of internal IDs" holds for generic pages.
 */
export function deriveCustomObjectDisplayName(
  definitions: readonly CustomObjectFieldDefinitionLike[],
  values: Record<string, unknown>,
  fallback = "Untitled",
): string {
  const ordered = [...definitions].sort(
    (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.key.localeCompare(b.key),
  )
  for (const definition of ordered) {
    const value = values[definition.key]
    if (typeof value === "string" && value.trim() !== "") {
      const trimmed = value.trim()
      return trimmed.length > 255 ? trimmed.slice(0, 255) : trimmed
    }
  }
  return fallback
}
