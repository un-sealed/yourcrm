import { requirePermission, type PermissionAction } from "@yourcrm/permissions"
import {
  CustomObjectConflictError,
  CustomObjectFieldNotFoundError,
  CustomObjectNotFoundError,
  CustomObjectRecordNotFoundError,
  CustomObjectValidationError,
} from "./errors"
import {
  buildCustomObjectRecordSchema,
  deriveCustomObjectDisplayName,
  mergeCustomObjectRecordValues,
  parseCustomObjectRecordValues,
  type CustomObjectFieldDefinitionLike,
} from "./field-schema"
import { parseCustomObjectFieldKey, parseCustomObjectSlug } from "./naming"
import {
  createCustomObjectFieldSchema,
  createCustomObjectRecordSchema,
  createCustomObjectSchema,
  customObjectQuerySchema,
  customObjectRecordQuerySchema,
  updateCustomObjectFieldSchema,
  updateCustomObjectRecordSchema,
  updateCustomObjectSchema,
} from "./schemas"
import type {
  CustomObjectDefinitionRecord,
  CustomObjectFieldRecord,
  CustomObjectListResult,
  CustomObjectRecordListResult,
  CustomObjectRecordRow,
  CustomObjectsServiceContext,
  CustomObjectsServiceDeps,
  CustomObjectWithFields,
} from "./types"

/**
 * Custom objects & fields domain service (spec 33, P0).
 *
 * This is a metadata engine, not CRUD: admins define object types and
 * fields at runtime, and record writes are validated against those
 * definitions by a zod schema built on the spot (`field-schema.ts`).
 *
 * Invariants it defends:
 *  - NO RUNTIME DDL. Definitions are rows; records are jsonb. Nothing here
 *    reaches SQL DDL, so a user-authored name can never become schema.
 *  - Slugs and field keys pass a strict allowlist and a reserved-word list
 *    before they reach a path, a jsonb key or the field join column.
 *  - Definitions are append-and-amend, never destructive: deleting a field
 *    soft-deletes the definition and leaves stored values alone, and a
 *    field's type can never change in place.
 *  - `requirePermission()` runs FIRST in every method. Definition changes
 *    are admin-only (spec 33 §8); records follow normal CRUD permissions.
 *
 * Domain events are NOT emitted yet: `@yourcrm/events` exposes no
 * `CustomObjectEvents` group, and this module may neither add one nor use
 * a string literal. See `CustomObjectsServiceDeps.events`.
 */

const OBJECT_PERMISSION_OBJECT = "custom_object"
const RECORD_PERMISSION_OBJECT = "custom_object_record"

function permissionOf(ctx: CustomObjectsServiceContext, object: string, action: PermissionAction) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object,
    action,
  }
}

/** Narrow a stored field row to what the schema builder needs. */
function toDefinition(field: CustomObjectFieldRecord): CustomObjectFieldDefinitionLike {
  return {
    key: field.key,
    label: field.label,
    fieldType: field.fieldType,
    required: field.required,
    displayOrder: field.displayOrder,
    options: field.options ?? null,
    defaultValue: field.defaultValue,
  }
}

export function createCustomObjectsService(deps: CustomObjectsServiceDeps) {
  async function requireObject(
    ctx: CustomObjectsServiceContext,
    slug: string,
  ): Promise<CustomObjectDefinitionRecord> {
    const normalized = parseCustomObjectSlug(slug)
    const object = await deps.store.findObjectBySlug(ctx.workspaceId, normalized)
    if (!object) throw new CustomObjectNotFoundError(normalized)
    return object
  }

  /** Live field definitions for an object, in display order. */
  async function fieldsOf(
    ctx: CustomObjectsServiceContext,
    object: CustomObjectDefinitionRecord,
  ): Promise<CustomObjectFieldRecord[]> {
    return deps.store.listFields(ctx.workspaceId, object.slug)
  }

  // -------------------------------------------------------------------------
  // Object definitions (admin only)
  // -------------------------------------------------------------------------

  async function listObjects(
    ctx: CustomObjectsServiceContext,
    rawQuery: unknown,
  ): Promise<CustomObjectListResult> {
    requirePermission(permissionOf(ctx, OBJECT_PERMISSION_OBJECT, "read"))
    const query = customObjectQuerySchema.parse(rawQuery)
    return deps.store.listObjects(ctx.workspaceId, query)
  }

  async function getObject(
    ctx: CustomObjectsServiceContext,
    slug: string,
  ): Promise<CustomObjectWithFields> {
    requirePermission(permissionOf(ctx, OBJECT_PERMISSION_OBJECT, "read"))
    const object = await requireObject(ctx, slug)
    return { object, fields: await fieldsOf(ctx, object) }
  }

  async function createObject(
    ctx: CustomObjectsServiceContext,
    rawInput: unknown,
  ): Promise<CustomObjectDefinitionRecord> {
    requirePermission(permissionOf(ctx, OBJECT_PERMISSION_OBJECT, "admin"))
    const input = createCustomObjectSchema.parse(rawInput)
    // Allowlist + reserved words BEFORE the slug can reach a path, a join
    // column or the database.
    const slug = parseCustomObjectSlug(input.slug)
    const clash = await deps.store.findObjectBySlug(ctx.workspaceId, slug)
    if (clash) {
      throw new CustomObjectConflictError(`an object with slug "${slug}" already exists`)
    }
    const object = await deps.store.createObject(
      ctx.workspaceId,
      {
        slug,
        name: input.name,
        pluralName: input.pluralName ?? `${input.name}s`,
        icon: input.icon ?? null,
        description: input.description ?? null,
      },
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: OBJECT_PERMISSION_OBJECT,
      recordId: object.id,
      after: object,
      correlationId: ctx.correlationId,
    })
    return object
  }

  /** Labels only — the slug is immutable, so `.strict()` rejects it as 400. */
  async function updateObject(
    ctx: CustomObjectsServiceContext,
    slug: string,
    rawPatch: unknown,
  ): Promise<CustomObjectDefinitionRecord> {
    requirePermission(permissionOf(ctx, OBJECT_PERMISSION_OBJECT, "admin"))
    const before = await requireObject(ctx, slug)
    const patch = updateCustomObjectSchema.parse(rawPatch)
    const after = await deps.store.updateObject(ctx.workspaceId, before.id, patch, ctx.actorId)
    if (!after) throw new CustomObjectNotFoundError(slug)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: OBJECT_PERMISSION_OBJECT,
      recordId: before.id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Soft-deletes the definition only. Its field definitions and records
   * stay on disk untouched, so `restoreObject` brings the whole object back
   * intact — deleting a definition must never be a data-loss event.
   */
  async function deleteObject(
    ctx: CustomObjectsServiceContext,
    slug: string,
  ): Promise<CustomObjectDefinitionRecord> {
    requirePermission(permissionOf(ctx, OBJECT_PERMISSION_OBJECT, "admin"))
    const before = await requireObject(ctx, slug)
    await deps.store.softDeleteObject(ctx.workspaceId, before.id, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: OBJECT_PERMISSION_OBJECT,
      recordId: before.id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  /** By id: a soft-deleted object can no longer be addressed by slug. */
  async function restoreObject(
    ctx: CustomObjectsServiceContext,
    id: string,
  ): Promise<CustomObjectDefinitionRecord> {
    requirePermission(permissionOf(ctx, OBJECT_PERMISSION_OBJECT, "admin"))
    await deps.store.restoreObject(ctx.workspaceId, id)
    const after = await deps.store.findObjectById(ctx.workspaceId, id)
    if (!after) throw new CustomObjectNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: OBJECT_PERMISSION_OBJECT,
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  // -------------------------------------------------------------------------
  // Field definitions (admin only)
  // -------------------------------------------------------------------------

  async function listFields(
    ctx: CustomObjectsServiceContext,
    slug: string,
  ): Promise<CustomObjectFieldRecord[]> {
    requirePermission(permissionOf(ctx, OBJECT_PERMISSION_OBJECT, "read"))
    return fieldsOf(ctx, await requireObject(ctx, slug))
  }

  async function createField(
    ctx: CustomObjectsServiceContext,
    slug: string,
    rawInput: unknown,
  ): Promise<CustomObjectFieldRecord> {
    requirePermission(permissionOf(ctx, OBJECT_PERMISSION_OBJECT, "admin"))
    const object = await requireObject(ctx, slug)
    const input = createCustomObjectFieldSchema.parse(rawInput)
    const key = parseCustomObjectFieldKey(input.key)
    const existing = await fieldsOf(ctx, object)
    if (existing.some((field) => field.key === key)) {
      throw new CustomObjectConflictError(`field "${key}" already exists on ${object.slug}`)
    }
    const candidate: CustomObjectFieldDefinitionLike = {
      key,
      label: input.label,
      fieldType: input.fieldType,
      required: input.required,
      displayOrder: input.displayOrder,
      options: input.options ?? null,
      defaultValue: input.defaultValue ?? null,
    }
    // Prove the resulting definition set still builds a schema before it is
    // persisted: a definition that cannot be validated against would block
    // every write to this object.
    buildCustomObjectRecordSchema([...existing.map(toDefinition), candidate])
    if (input.defaultValue !== undefined && input.defaultValue !== null) {
      // The default is validated like any other value, against its own
      // field, so a bad default can never become a back door.
      parseCustomObjectRecordValues([candidate], { [key]: input.defaultValue }, { partial: true })
    }
    const field = await deps.store.createField(
      ctx.workspaceId,
      {
        objectType: object.slug,
        key,
        label: input.label,
        fieldType: input.fieldType,
        options: input.options ?? null,
        required: input.required,
        displayOrder: input.displayOrder,
        defaultValue: input.defaultValue ?? null,
      },
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "custom_field",
      recordId: field.id,
      after: field,
      correlationId: ctx.correlationId,
    })
    return field
  }

  /**
   * Amend a field definition.
   *
   * TYPE CHANGES ARE REJECTED, not migrated. `key` and `fieldType` are not
   * in `updateCustomObjectFieldSchema`, and it is `.strict()`, so a patch
   * carrying either fails with an explicit "unrecognized key" 400. The
   * reason is data integrity: every record stores this field under this key
   * as raw JSON, so flipping `text` -> `number` would leave every existing
   * row holding a value its own definition calls invalid, with no
   * transactional way to convert them. To change a type, delete the field
   * (values are preserved, see `deleteField`) and add a new one.
   *
   * Narrowing `options` or flipping `required` on IS allowed: neither
   * rewrites stored data. Records written before the change keep their
   * values and are only held to the new rule on their next write, which is
   * why record patches validate in partial mode.
   */
  async function updateField(
    ctx: CustomObjectsServiceContext,
    slug: string,
    fieldId: string,
    rawPatch: unknown,
  ): Promise<CustomObjectFieldRecord> {
    requirePermission(permissionOf(ctx, OBJECT_PERMISSION_OBJECT, "admin"))
    const object = await requireObject(ctx, slug)
    const patch = updateCustomObjectFieldSchema.parse(rawPatch)
    const before = await deps.store.findFieldById(ctx.workspaceId, fieldId)
    if (!before || before.objectType !== object.slug) {
      throw new CustomObjectFieldNotFoundError(fieldId)
    }
    const next: CustomObjectFieldDefinitionLike = {
      // Carried over, never patched — this is the type-change guard made
      // explicit at the one place a definition is rewritten.
      key: before.key,
      fieldType: before.fieldType,
      label: patch.label ?? before.label,
      required: patch.required ?? before.required,
      displayOrder: patch.displayOrder ?? before.displayOrder,
      options: patch.options === undefined ? (before.options ?? null) : patch.options,
      defaultValue: patch.defaultValue === undefined ? before.defaultValue : patch.defaultValue,
    }
    buildCustomObjectRecordSchema([next])
    if (next.defaultValue !== undefined && next.defaultValue !== null) {
      parseCustomObjectRecordValues([next], { [next.key]: next.defaultValue }, { partial: true })
    }
    const after = await deps.store.updateField(ctx.workspaceId, fieldId, patch, ctx.actorId)
    if (!after) throw new CustomObjectFieldNotFoundError(fieldId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "custom_field",
      recordId: fieldId,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * SOFT delete. The definition row gets `deleted_at`; the values already
   * stored under its key stay in every record's jsonb payload. Record
   * patches validate only the incoming keys and merge over the stored
   * payload, so those orphaned values ride along untouched and reappear in
   * full if the definition is restored. Hard-deleting a definition would
   * destroy a column's worth of customer data with one click.
   */
  async function deleteField(
    ctx: CustomObjectsServiceContext,
    slug: string,
    fieldId: string,
  ): Promise<CustomObjectFieldRecord> {
    requirePermission(permissionOf(ctx, OBJECT_PERMISSION_OBJECT, "admin"))
    const object = await requireObject(ctx, slug)
    const before = await deps.store.findFieldById(ctx.workspaceId, fieldId)
    if (!before || before.objectType !== object.slug) {
      throw new CustomObjectFieldNotFoundError(fieldId)
    }
    await deps.store.softDeleteField(ctx.workspaceId, fieldId, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "custom_field",
      recordId: fieldId,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  async function listRecords(
    ctx: CustomObjectsServiceContext,
    slug: string,
    rawQuery: unknown,
  ): Promise<CustomObjectRecordListResult> {
    requirePermission(permissionOf(ctx, RECORD_PERMISSION_OBJECT, "read"))
    const object = await requireObject(ctx, slug)
    const query = customObjectRecordQuerySchema.parse(rawQuery)
    const match: Record<string, string> = {}
    if (query.field !== undefined && query.value !== undefined) {
      const key = parseCustomObjectFieldKey(query.field)
      const fields = await fieldsOf(ctx, object)
      if (!fields.some((field) => field.key === key)) {
        throw new CustomObjectValidationError(`unknown field "${key}" on ${object.slug}`)
      }
      match[key] = query.value
    }
    return deps.store.listRecords(ctx.workspaceId, object.id, {
      limit: query.limit,
      order: query.order,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.query === undefined ? {} : { query: query.query }),
      ...(Object.keys(match).length === 0 ? {} : { match }),
    })
  }

  async function getRecord(
    ctx: CustomObjectsServiceContext,
    slug: string,
    id: string,
  ): Promise<{
    object: CustomObjectDefinitionRecord
    fields: CustomObjectFieldRecord[]
    record: CustomObjectRecordRow
  }> {
    requirePermission(permissionOf(ctx, RECORD_PERMISSION_OBJECT, "read"))
    const object = await requireObject(ctx, slug)
    const record = await deps.store.findRecordById(ctx.workspaceId, object.id, id)
    if (!record) throw new CustomObjectRecordNotFoundError(id)
    return { object, fields: await fieldsOf(ctx, object), record }
  }

  async function createRecord(
    ctx: CustomObjectsServiceContext,
    slug: string,
    rawInput: unknown,
  ): Promise<CustomObjectRecordRow> {
    requirePermission(permissionOf(ctx, RECORD_PERMISSION_OBJECT, "create"))
    const object = await requireObject(ctx, slug)
    const input = createCustomObjectRecordSchema.parse(rawInput)
    const definitions = (await fieldsOf(ctx, object)).map(toDefinition)
    // Runtime schema, built from THIS object's live definitions, applied to
    // THIS payload. Defaults are filled first, then everything is validated.
    const fieldValues = parseCustomObjectRecordValues(definitions, input.values ?? {})
    const record = await deps.store.createRecord(
      ctx.workspaceId,
      {
        objectId: object.id,
        displayName: deriveCustomObjectDisplayName(definitions, fieldValues),
        fieldValues,
        ownerId: input.ownerId ?? ctx.actorId,
      },
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: RECORD_PERMISSION_OBJECT,
      recordId: record.id,
      after: record,
      correlationId: ctx.correlationId,
    })
    return record
  }

  async function updateRecord(
    ctx: CustomObjectsServiceContext,
    slug: string,
    id: string,
    rawPatch: unknown,
  ): Promise<CustomObjectRecordRow> {
    requirePermission(permissionOf(ctx, RECORD_PERMISSION_OBJECT, "update"))
    const object = await requireObject(ctx, slug)
    const patch = updateCustomObjectRecordSchema.parse(rawPatch)
    const before = await deps.store.findRecordById(ctx.workspaceId, object.id, id)
    if (!before) throw new CustomObjectRecordNotFoundError(id)
    const definitions = (await fieldsOf(ctx, object)).map(toDefinition)
    const storePatch: Record<string, unknown> = {}
    if (patch.values !== undefined) {
      // Partial mode: only the keys the caller sent are validated, then
      // merged over what is stored. Values of soft-deleted fields are
      // neither validated nor dropped — they simply survive.
      const validated = parseCustomObjectRecordValues(definitions, patch.values, { partial: true })
      const merged = mergeCustomObjectRecordValues(before.fieldValues, validated)
      storePatch.fieldValues = merged
      storePatch.displayName = deriveCustomObjectDisplayName(definitions, merged)
    }
    if (patch.ownerId !== undefined) storePatch.ownerId = patch.ownerId
    const after = await deps.store.updateRecord(
      ctx.workspaceId,
      object.id,
      id,
      storePatch,
      ctx.actorId,
    )
    if (!after) throw new CustomObjectRecordNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: RECORD_PERMISSION_OBJECT,
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function deleteRecord(
    ctx: CustomObjectsServiceContext,
    slug: string,
    id: string,
  ): Promise<CustomObjectRecordRow> {
    requirePermission(permissionOf(ctx, RECORD_PERMISSION_OBJECT, "delete"))
    const object = await requireObject(ctx, slug)
    const before = await deps.store.findRecordById(ctx.workspaceId, object.id, id)
    if (!before) throw new CustomObjectRecordNotFoundError(id)
    await deps.store.softDeleteRecord(ctx.workspaceId, id, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: RECORD_PERMISSION_OBJECT,
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restoreRecord(
    ctx: CustomObjectsServiceContext,
    slug: string,
    id: string,
  ): Promise<CustomObjectRecordRow> {
    requirePermission(permissionOf(ctx, RECORD_PERMISSION_OBJECT, "update"))
    const object = await requireObject(ctx, slug)
    await deps.store.restoreRecord(ctx.workspaceId, id)
    const after = await deps.store.findRecordById(ctx.workspaceId, object.id, id)
    if (!after) throw new CustomObjectRecordNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: RECORD_PERMISSION_OBJECT,
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  return {
    listObjects,
    getObject,
    createObject,
    updateObject,
    deleteObject,
    restoreObject,
    listFields,
    createField,
    updateField,
    deleteField,
    listRecords,
    getRecord,
    createRecord,
    updateRecord,
    deleteRecord,
    restoreRecord,
  }
}

export type CustomObjectsService = ReturnType<typeof createCustomObjectsService>
