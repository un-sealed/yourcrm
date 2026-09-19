import { and, asc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  customObjectDefinitions,
  customObjectRecords,
  type CustomObjectDefinition,
  type CustomObjectFieldValues,
  type CustomObjectRecord,
} from "../schema/custom-objects"
import { createBaseRepository } from "./base-repository"

/**
 * Custom objects persistence (spec 33, P0).
 *
 * NO RUNTIME DDL: nothing in this file builds or executes `CREATE TABLE` /
 * `ALTER TABLE`. User-defined object types are rows; their records are rows
 * with a jsonb payload. Every dynamic part of a query (slug, field key,
 * filter value) is either matched against a strict allowlist pattern here
 * or bound as a parameter by drizzle — never interpolated into SQL text.
 *
 * Domain rules (which words are reserved, which types exist, whether a
 * payload satisfies the definitions) live in
 * `@yourcrm/crm/src/custom-objects`; this layer keeps the structural
 * guarantees that must hold no matter who calls it.
 */

export type CreateCustomObjectDefinitionInput = {
  slug: string
  name: string
  pluralName: string
  icon?: string | null | undefined
  description?: string | null | undefined
}

/**
 * Slug is absent on purpose: it is the join key to
 * `custom_field_definitions.object_type` and it appears in API paths, so it
 * is immutable once created. Renaming an object renames its labels.
 */
export type UpdateCustomObjectDefinitionInput = {
  name?: string | undefined
  pluralName?: string | undefined
  icon?: string | null | undefined
  description?: string | null | undefined
}

export type CreateCustomObjectRecordInput = {
  objectId: string
  displayName: string
  fieldValues: CustomObjectFieldValues
  ownerId?: string | null | undefined
}

export type UpdateCustomObjectRecordInput = {
  displayName?: string | undefined
  fieldValues?: CustomObjectFieldValues | undefined
  ownerId?: string | null | undefined
}

export type SearchCustomObjectRecordsOptions = {
  workspaceId: string
  objectId: string
  limit?: number | undefined
  cursor?: string | undefined
  order?: "asc" | "desc" | undefined
  /** Case-insensitive match on the denormalized display name. */
  query?: string | undefined
  /** Exact jsonb matches, `{ fieldKey: value }`, served by the GIN index. */
  match?: Record<string, string> | undefined
}

/** Slug grammar: lowercase, starts with a letter, single separators only. */
export const CUSTOM_OBJECT_SLUG_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/

/** Field-key grammar, mirroring `normalizeCustomFieldKey` in custom-fields. */
export const CUSTOM_OBJECT_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]*$/

/**
 * Keys that must never reach a jsonb payload or an object literal built
 * from one. `__proto__`/`constructor`/`prototype` are prototype-pollution
 * vectors the moment a stored payload is spread into a JS object; the rest
 * shadow the record's own columns. This is the structural floor — the
 * domain layer additionally rejects product-level reserved words.
 */
export const CUSTOM_OBJECT_UNSAFE_FIELD_KEYS: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
  "id",
  "workspace_id",
  "object_id",
  "owner_id",
  "display_name",
  "field_values",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "deleted_at",
]

/**
 * Lowercase, trim and verify a slug against the allowlist pattern. Throws
 * rather than sanitizing: silently rewriting a user's slug would change the
 * identity of an object between the request and the row.
 */
export function normalizeCustomObjectSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase()
  if (normalized.length < 2 || normalized.length > 64) {
    throw new Error("custom_object_definitions: slug must be 2-64 characters")
  }
  if (!CUSTOM_OBJECT_SLUG_PATTERN.test(normalized)) {
    throw new Error(
      "custom_object_definitions: slug must be lowercase a-z, 0-9 and single - or _ separators",
    )
  }
  return normalized
}

/** Trimmed, whitespace-collapsed label within the column length. */
export function normalizeCustomObjectLabel(value: string, field: string, max = 128): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) {
    throw new Error(`custom_object_definitions: ${field} must not be empty`)
  }
  if (trimmed.length > max) {
    throw new Error(`custom_object_definitions: ${field} must be at most ${max} characters`)
  }
  return trimmed
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Structural gate for a record payload. Guarantees a plain JSON object
 * whose keys are safe field keys — so a caller that skipped the domain
 * validation still cannot store `__proto__` or a column-shadowing key.
 */
export function assertSafeCustomObjectFieldValues(values: unknown): CustomObjectFieldValues {
  if (!isPlainObject(values)) {
    throw new Error("custom_object_records: fieldValues must be a JSON object")
  }
  const safe: CustomObjectFieldValues = {}
  for (const key of Object.keys(values)) {
    if (CUSTOM_OBJECT_UNSAFE_FIELD_KEYS.includes(key)) {
      throw new Error(`custom_object_records: field key "${key}" is reserved`)
    }
    if (!CUSTOM_OBJECT_FIELD_KEY_PATTERN.test(key) || key.length > 128) {
      throw new Error(`custom_object_records: field key "${key}" is not a valid key`)
    }
    // Object.defineProperty, not assignment: assignment through a getter on
    // the prototype chain is exactly what the key allowlist guards against.
    Object.defineProperty(safe, key, {
      value: values[key],
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return safe
}

/** Display name for a record: never empty, never longer than the column. */
export function normalizeCustomObjectRecordDisplayName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) return "Untitled"
  return trimmed.length > 255 ? trimmed.slice(0, 255) : trimmed
}

/** Object definitions + their records. Fields reuse the custom-field catalog. */
export function createCustomObjectsRepository() {
  const objects = createBaseRepository(customObjectDefinitions)
  const records = createBaseRepository(customObjectRecords)

  return {
    objects,
    records,

    async createObject(
      db: Database,
      workspaceId: string,
      input: CreateCustomObjectDefinitionInput,
      actorId?: string,
    ): Promise<CustomObjectDefinition> {
      const rows = await db
        .insert(customObjectDefinitions)
        .values({
          workspaceId,
          slug: normalizeCustomObjectSlug(input.slug),
          name: normalizeCustomObjectLabel(input.name, "name"),
          pluralName: normalizeCustomObjectLabel(input.pluralName, "pluralName"),
          icon: input.icon?.trim() || null,
          description: input.description?.trim() || null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("custom_object_definitions.create: insert returned no rows")
      return row
    },

    /** Cursor-paginated object list with optional name/slug search. */
    async searchObjects(
      db: Database,
      opts: {
        workspaceId: string
        limit?: number | undefined
        cursor?: string | undefined
        order?: "asc" | "desc" | undefined
        query?: string | undefined
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const match = or(
          ilike(customObjectDefinitions.name, q),
          ilike(customObjectDefinitions.pluralName, q),
          ilike(customObjectDefinitions.slug, q),
        )
        if (match) conditions.push(match)
      }
      const result = await objects.list(db, { ...opts, where: conditions })
      return { data: result.data as CustomObjectDefinition[], pagination: result.pagination }
    },

    async findObjectById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<CustomObjectDefinition | null> {
      return (await objects.findById(db, workspaceId, id)) as CustomObjectDefinition | null
    },

    async findObjectBySlug(
      db: Database,
      workspaceId: string,
      slug: string,
    ): Promise<CustomObjectDefinition | null> {
      const rows = await db
        .select()
        .from(customObjectDefinitions)
        .where(
          and(
            eq(customObjectDefinitions.workspaceId, workspaceId),
            eq(customObjectDefinitions.slug, normalizeCustomObjectSlug(slug)),
            isNull(customObjectDefinitions.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    /** Labels only — the slug is immutable (it is the field join key). */
    async updateObject(
      db: Database,
      workspaceId: string,
      id: string,
      patch: UpdateCustomObjectDefinitionInput,
      actorId?: string,
    ): Promise<CustomObjectDefinition | null> {
      const values: Record<string, unknown> = { updatedAt: new Date() }
      if (patch.name !== undefined) values.name = normalizeCustomObjectLabel(patch.name, "name")
      if (patch.pluralName !== undefined) {
        values.pluralName = normalizeCustomObjectLabel(patch.pluralName, "pluralName")
      }
      if (patch.icon !== undefined) values.icon = patch.icon?.trim() || null
      if (patch.description !== undefined) values.description = patch.description?.trim() || null
      if (actorId !== undefined) values.updatedBy = actorId
      const rows = await db
        .update(customObjectDefinitions)
        .set(values)
        .where(
          and(
            eq(customObjectDefinitions.id, id),
            eq(customObjectDefinitions.workspaceId, workspaceId),
            isNull(customObjectDefinitions.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async createRecord(
      db: Database,
      workspaceId: string,
      input: CreateCustomObjectRecordInput,
      actorId?: string,
    ): Promise<CustomObjectRecord> {
      const rows = await db
        .insert(customObjectRecords)
        .values({
          workspaceId,
          objectId: input.objectId,
          ownerId: input.ownerId ?? actorId ?? null,
          displayName: normalizeCustomObjectRecordDisplayName(input.displayName),
          fieldValues: assertSafeCustomObjectFieldValues(input.fieldValues),
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("custom_object_records.create: insert returned no rows")
      return row
    },

    /**
     * Cursor-paginated records for one object. `match` entries are bound as
     * parameters into a jsonb containment test, so a filter value can never
     * become SQL; keys are allowlist-checked first.
     */
    async searchRecords(db: Database, opts: SearchCustomObjectRecordsOptions) {
      const conditions: SQL[] = [eq(customObjectRecords.objectId, opts.objectId)]
      if (opts.query) {
        conditions.push(ilike(customObjectRecords.displayName, `%${opts.query.trim()}%`))
      }
      for (const [key, value] of Object.entries(opts.match ?? {})) {
        const probe = assertSafeCustomObjectFieldValues({ [key]: value })
        conditions.push(sql`${customObjectRecords.fieldValues} @> ${JSON.stringify(probe)}::jsonb`)
      }
      const result = await records.list(db, { ...opts, where: conditions })
      return { data: result.data as CustomObjectRecord[], pagination: result.pagination }
    },

    async findRecordById(
      db: Database,
      workspaceId: string,
      objectId: string,
      id: string,
    ): Promise<CustomObjectRecord | null> {
      const rows = await db
        .select()
        .from(customObjectRecords)
        .where(
          and(
            eq(customObjectRecords.id, id),
            eq(customObjectRecords.workspaceId, workspaceId),
            eq(customObjectRecords.objectId, objectId),
            isNull(customObjectRecords.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    /**
     * Whole-payload write. The DOMAIN layer merges a validated patch over
     * the stored payload so values of soft-deleted fields survive; this
     * method only guarantees the payload it is handed is structurally safe.
     */
    async updateRecord(
      db: Database,
      workspaceId: string,
      objectId: string,
      id: string,
      patch: UpdateCustomObjectRecordInput,
      actorId?: string,
    ): Promise<CustomObjectRecord | null> {
      const values: Record<string, unknown> = { updatedAt: new Date() }
      if (patch.displayName !== undefined) {
        values.displayName = normalizeCustomObjectRecordDisplayName(patch.displayName)
      }
      if (patch.fieldValues !== undefined) {
        values.fieldValues = assertSafeCustomObjectFieldValues(patch.fieldValues)
      }
      if (patch.ownerId !== undefined) values.ownerId = patch.ownerId
      if (actorId !== undefined) values.updatedBy = actorId
      const rows = await db
        .update(customObjectRecords)
        .set(values)
        .where(
          and(
            eq(customObjectRecords.id, id),
            eq(customObjectRecords.workspaceId, workspaceId),
            eq(customObjectRecords.objectId, objectId),
            isNull(customObjectRecords.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    /** Live records of one object, oldest first — used by exports and tests. */
    async listAllRecords(
      db: Database,
      workspaceId: string,
      objectId: string,
    ): Promise<CustomObjectRecord[]> {
      return db
        .select()
        .from(customObjectRecords)
        .where(
          and(
            eq(customObjectRecords.workspaceId, workspaceId),
            eq(customObjectRecords.objectId, objectId),
            isNull(customObjectRecords.deletedAt),
          ),
        )
        .orderBy(asc(customObjectRecords.createdAt))
    },
  }
}

export type CustomObjectsRepository = ReturnType<typeof createCustomObjectsRepository>
