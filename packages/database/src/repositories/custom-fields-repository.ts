import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import type { Database } from "../client"
import {
  customFieldDefinitions,
  customFieldValues,
  isCustomFieldType,
  type CustomFieldDefaultValue,
  type CustomFieldDefinition,
  type CustomFieldOptions,
  type CustomFieldType,
  type CustomFieldValue,
} from "../schema/custom-fields"
import { createBaseRepository } from "./base-repository"

export type CreateCustomFieldDefinitionInput = {
  objectType: string
  key: string
  label: string
  fieldType: CustomFieldType | string
  options?: CustomFieldOptions | undefined
  required?: boolean | undefined
  displayOrder?: number | undefined
  /** Added additively by the custom-objects module (spec 33). */
  defaultValue?: CustomFieldDefaultValue | undefined
}

export type UpdateCustomFieldDefinitionInput = {
  label?: string | undefined
  options?: CustomFieldOptions | undefined
  required?: boolean | undefined
  displayOrder?: number | undefined
  /** Added additively by the custom-objects module (spec 33). */
  defaultValue?: CustomFieldDefaultValue | undefined
}

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/

/** Stable programmatic key: lowercase snake_case so API consumers can rely on it. */
export function normalizeCustomFieldKey(key: string): string {
  const normalized = key
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
  if (!KEY_PATTERN.test(normalized)) {
    throw new Error(
      "custom_field_definitions.create: key must start with a letter and contain only a-z, 0-9, _",
    )
  }
  if (normalized.length > 128) {
    throw new Error("custom_field_definitions.create: key must be at most 128 characters")
  }
  return normalized
}

/**
 * Pure per-type value check against a definition row. Returns an error
 * message, or null when the value is acceptable. `null`/`undefined` values
 * are always acceptable (clearing a field); `required` is enforced by domain
 * services that see the whole record, not here.
 */
export function validateCustomFieldValue(
  definition: Pick<CustomFieldDefinition, "fieldType" | "options">,
  value: unknown,
): string | null {
  if (value === null || value === undefined) return null
  switch (definition.fieldType) {
    case "text":
    case "url":
    case "email":
    case "date":
      return typeof value === "string" ? null : `expected a string for ${definition.fieldType}`
    case "number":
      return typeof value === "number" ? null : "expected a number"
    case "boolean":
      return typeof value === "boolean" ? null : "expected a boolean"
    case "select": {
      if (typeof value !== "string") return "expected a string option for select"
      const allowed = optionValues(definition.options)
      if (allowed && !allowed.includes(value)) return `value is not an allowed option`
      return null
    }
    case "multiselect": {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        return "expected an array of strings for multiselect"
      }
      const allowed = optionValues(definition.options)
      if (allowed && !value.every((v) => allowed.includes(v))) {
        return "value contains an option that is not allowed"
      }
      return null
    }
    default:
      return `unknown field type: ${definition.fieldType}`
  }
}

function optionValues(options: CustomFieldOptions): string[] | null {
  if (!options) return null
  return options.map((o) => (typeof o === "string" ? o : o.value))
}

/** Definitions: admin-managed field catalog per object. */
export function createCustomFieldDefinitionsRepository() {
  const base = createBaseRepository(customFieldDefinitions)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateCustomFieldDefinitionInput,
      actorId?: string,
    ): Promise<CustomFieldDefinition> {
      if (input.objectType.trim().length === 0) {
        throw new Error("custom_field_definitions.create: objectType must not be empty")
      }
      if (!isCustomFieldType(input.fieldType)) {
        throw new Error(
          `custom_field_definitions.create: unsupported field type: ${String(input.fieldType)}`,
        )
      }
      if (input.label.trim().length === 0) {
        throw new Error("custom_field_definitions.create: label must not be empty")
      }
      if (
        (input.fieldType === "select" || input.fieldType === "multiselect") &&
        (!Array.isArray(input.options) || input.options.length === 0)
      ) {
        throw new Error(
          "custom_field_definitions.create: select/multiselect requires a non-empty options array",
        )
      }
      // A bad default must never become a back door for invalid data: it is
      // checked against this field's own type before the row is written.
      const defaultValue = input.defaultValue ?? null
      const defaultError = validateCustomFieldValue(
        { fieldType: input.fieldType, options: input.options ?? null },
        defaultValue,
      )
      if (defaultError) {
        throw new Error(`custom_field_definitions.create: default ${defaultError}`)
      }
      const rows = await db
        .insert(customFieldDefinitions)
        .values({
          workspaceId,
          objectType: input.objectType,
          key: normalizeCustomFieldKey(input.key),
          label: input.label.trim(),
          fieldType: input.fieldType,
          options: input.options ?? null,
          defaultValue,
          required: input.required ?? false,
          displayOrder: input.displayOrder ?? 0,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("custom_field_definitions.create: insert returned no rows")
      return row
    },

    /** Live definitions for one object, in display order. */
    async listByObject(
      db: Database,
      workspaceId: string,
      objectType: string,
    ): Promise<CustomFieldDefinition[]> {
      return db
        .select()
        .from(customFieldDefinitions)
        .where(
          and(
            eq(customFieldDefinitions.workspaceId, workspaceId),
            eq(customFieldDefinitions.objectType, objectType),
            isNull(customFieldDefinitions.deletedAt),
          ),
        )
        .orderBy(asc(customFieldDefinitions.displayOrder))
    },

    /**
     * Patch label/options/required/order/default only — key and fieldType
     * are immutable once values may exist (changing a type in place would
     * silently reinterpret every stored value). Returns the row, or null.
     */
    async update(
      db: Database,
      workspaceId: string,
      id: string,
      patch: UpdateCustomFieldDefinitionInput,
      actorId?: string,
    ): Promise<CustomFieldDefinition | null> {
      const rows = await db
        .update(customFieldDefinitions)
        .set({
          ...patch,
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(
          and(
            eq(customFieldDefinitions.id, id),
            eq(customFieldDefinitions.workspaceId, workspaceId),
            isNull(customFieldDefinitions.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },
  }
}

export type CustomFieldDefinitionsRepository = ReturnType<
  typeof createCustomFieldDefinitionsRepository
>

/** Values: one row per (definition, record); upsert via setValue. */
export function createCustomFieldValuesRepository() {
  const base = createBaseRepository(customFieldValues)

  return {
    ...base,

    /**
     * Insert or overwrite the value for one field on one record. Restores a
     * soft-deleted row first so history survives re-entry. Callers validate
     * with validateCustomFieldValue() before writing.
     */
    async setValue(
      db: Database,
      workspaceId: string,
      definitionId: string,
      recordId: string,
      value: unknown,
      actorId?: string,
    ): Promise<CustomFieldValue> {
      const scope = and(
        eq(customFieldValues.workspaceId, workspaceId),
        eq(customFieldValues.definitionId, definitionId),
        eq(customFieldValues.recordId, recordId),
      )
      const touched = await db
        .update(customFieldValues)
        .set({
          value,
          deletedAt: null,
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(scope)
        .returning()
      const existing = touched[0]
      if (existing) return existing
      const rows = await db
        .insert(customFieldValues)
        .values({
          workspaceId,
          definitionId,
          recordId,
          value,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .onConflictDoNothing()
        .returning()
      const created = rows[0]
      if (!created) throw new Error("custom_field_values.setValue: insert returned no rows")
      return created
    },

    async getValue(
      db: Database,
      workspaceId: string,
      definitionId: string,
      recordId: string,
    ): Promise<CustomFieldValue | null> {
      const rows = await db
        .select()
        .from(customFieldValues)
        .where(
          and(
            eq(customFieldValues.workspaceId, workspaceId),
            eq(customFieldValues.definitionId, definitionId),
            eq(customFieldValues.recordId, recordId),
            isNull(customFieldValues.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    /** Bulk fetch for rendering record lists; callers group by recordId. */
    async listForRecords(
      db: Database,
      workspaceId: string,
      recordIds: string[],
    ): Promise<CustomFieldValue[]> {
      if (recordIds.length === 0) return []
      return db
        .select()
        .from(customFieldValues)
        .where(
          and(
            eq(customFieldValues.workspaceId, workspaceId),
            inArray(customFieldValues.recordId, recordIds),
            isNull(customFieldValues.deletedAt),
          ),
        )
    },
  }
}

export type CustomFieldValuesRepository = ReturnType<typeof createCustomFieldValuesRepository>
