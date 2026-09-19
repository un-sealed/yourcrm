import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"
import type { CustomObjectFieldOption } from "./field-schema"

/**
 * Custom-objects service ports, mirroring the people reference module.
 *
 * `@yourcrm/crm` has no database dependency, so the service talks to this
 * structural store port; the API layer adapts the drizzle repositories
 * (`custom-objects-repository.ts` plus the existing
 * `custom-fields-repository.ts`) to it, and hermetic tests satisfy it with
 * `createStore` fakes.
 */

/** A user-defined object type. */
export type CustomObjectDefinitionRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  slug: string
  name: string
  pluralName: string
}

/**
 * A field definition row. This is an ordinary `custom_field_definitions`
 * row — the same table that carries fields of built-in objects — with
 * `objectType` holding the custom object's slug.
 */
export type CustomObjectFieldRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  objectType: string
  key: string
  label: string
  fieldType: string
  required: boolean
  displayOrder: number
  options?: readonly CustomObjectFieldOption[] | null | undefined
  defaultValue?: unknown
}

/** One record of a custom object; `fieldValues` is the jsonb payload. */
export type CustomObjectRecordRow = Record<string, unknown> & {
  id: string
  workspaceId: string
  objectId: string
  displayName: string
  fieldValues: Record<string, unknown>
}

/** Object definition plus its live fields, in display order. */
export type CustomObjectWithFields = {
  object: CustomObjectDefinitionRecord
  fields: CustomObjectFieldRecord[]
}

export type CustomObjectListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
}

export type CustomObjectListResult = {
  data: CustomObjectDefinitionRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type CustomObjectRecordListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  /** Exact field-value matches, already checked against live definitions. */
  match?: Record<string, string>
}

export type CustomObjectRecordListResult = {
  data: CustomObjectRecordRow[]
  pagination: { nextCursor: string | null; limit: number }
}

export type CustomObjectsStore = {
  listObjects(workspaceId: string, query: CustomObjectListQuery): Promise<CustomObjectListResult>
  findObjectById(workspaceId: string, id: string): Promise<CustomObjectDefinitionRecord | null>
  findObjectBySlug(workspaceId: string, slug: string): Promise<CustomObjectDefinitionRecord | null>
  createObject(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<CustomObjectDefinitionRecord>
  updateObject(
    workspaceId: string,
    id: string,
    patch: Record<string, unknown>,
    actorId?: string,
  ): Promise<CustomObjectDefinitionRecord | null>
  softDeleteObject(workspaceId: string, id: string, actorId?: string): Promise<void>
  restoreObject(workspaceId: string, id: string): Promise<void>

  /** Live field definitions for an object type, in display order. */
  listFields(workspaceId: string, objectType: string): Promise<CustomObjectFieldRecord[]>
  findFieldById(workspaceId: string, id: string): Promise<CustomObjectFieldRecord | null>
  createField(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<CustomObjectFieldRecord>
  updateField(
    workspaceId: string,
    id: string,
    patch: Record<string, unknown>,
    actorId?: string,
  ): Promise<CustomObjectFieldRecord | null>
  /** SOFT delete: the definition is hidden, stored values are untouched. */
  softDeleteField(workspaceId: string, id: string, actorId?: string): Promise<void>

  listRecords(
    workspaceId: string,
    objectId: string,
    query: CustomObjectRecordListQuery,
  ): Promise<CustomObjectRecordListResult>
  findRecordById(
    workspaceId: string,
    objectId: string,
    id: string,
  ): Promise<CustomObjectRecordRow | null>
  createRecord(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<CustomObjectRecordRow>
  updateRecord(
    workspaceId: string,
    objectId: string,
    id: string,
    patch: Record<string, unknown>,
    actorId?: string,
  ): Promise<CustomObjectRecordRow | null>
  softDeleteRecord(workspaceId: string, id: string, actorId?: string): Promise<void>
  restoreRecord(workspaceId: string, id: string): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type CustomObjectAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type CustomObjectsServiceContext = ServiceContext

export type CustomObjectsServiceDeps = {
  store: CustomObjectsStore
  audit: AuditWriter<CustomObjectAuditInput>
  /**
   * BLOCKED, wired anyway. `@yourcrm/events` has no `CustomObjectEvents`
   * group, and this module may not add one or emit a string literal, so no
   * domain event is emitted yet (spec 33 asks for `custom_object.created`,
   * `custom_field.created`, `schema.updated`). The port stays in the deps
   * so emission is a one-line change once the constants land; the service
   * test pins the current no-event behaviour so it cannot drift silently.
   */
  events?: EventEmitter
}
