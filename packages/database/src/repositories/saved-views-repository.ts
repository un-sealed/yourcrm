import { and, asc, eq, isNull, or } from "drizzle-orm"
import type { Database } from "../client"
import {
  savedViews,
  type SavedView,
  type SavedViewColumnConfig,
  type SavedViewFilterNode,
  type SavedViewSortConfig,
} from "../schema/saved-views"
import { createBaseRepository } from "./base-repository"

export type CreateSavedViewInput = {
  objectType: string
  name: string
  ownerId?: string | null | undefined
  isShared?: boolean | undefined
  filters?: SavedViewFilterNode | null | undefined
  columns?: SavedViewColumnConfig | null | undefined
  sort?: SavedViewSortConfig | null | undefined
}

export type UpdateSavedViewInput = {
  name?: string | undefined
  isShared?: boolean | undefined
  filters?: SavedViewFilterNode | null | undefined
  columns?: SavedViewColumnConfig | null | undefined
  sort?: SavedViewSortConfig | null | undefined
}

export const FILTER_OPERATORS = [
  "eq",
  "neq",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in",
  "not_in",
  "is_null",
  "is_not_null",
] as const

function isGroup(node: Record<string, unknown>): boolean {
  return node.op === "and" || node.op === "or"
}

function validateNode(node: unknown, path: string): string | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return `${path}: filter node must be an object`
  }
  const rec = node as Record<string, unknown>
  if (isGroup(rec)) {
    if (!Array.isArray(rec.conditions) || rec.conditions.length === 0) {
      return `${path}: ${String(rec.op)} group needs a non-empty conditions array`
    }
    for (let i = 0; i < rec.conditions.length; i++) {
      const err = validateNode(rec.conditions[i], `${path}.conditions[${String(i)}]`)
      if (err) return err
    }
    return null
  }
  if (typeof rec.field !== "string" || rec.field.length === 0) {
    return `${path}: condition needs a field name`
  }
  if (typeof rec.operator !== "string") return `${path}: condition needs an operator`
  if (!(FILTER_OPERATORS as readonly string[]).includes(rec.operator)) {
    return `${path}: unsupported operator: ${rec.operator}`
  }
  return null
}

/**
 * Pure structural check for the persisted filter tree. Returns an error
 * message, or null when valid. `null`/`undefined` means "no filter".
 */
export function validateSavedViewFilters(filters: unknown): string | null {
  if (filters === null || filters === undefined) return null
  const err = validateNode(filters, "filter")
  if (err) return err
  const rec = filters as Record<string, unknown>
  if (!isGroup(rec)) return "filter: root node must be an and/or group"
  return null
}

export function validateSavedViewColumns(columns: unknown): string | null {
  if (columns === null || columns === undefined) return null
  if (!Array.isArray(columns)) return "columns: must be an array"
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i] as Record<string, unknown>
    if (!col || typeof col !== "object" || typeof col.key !== "string" || col.key.length === 0) {
      return `columns[${String(i)}]: each column needs a key`
    }
  }
  return null
}

export function validateSavedViewSort(sort: unknown): string | null {
  if (sort === null || sort === undefined) return null
  if (!Array.isArray(sort)) return "sort: must be an array"
  for (let i = 0; i < sort.length; i++) {
    const entry = sort[i] as Record<string, unknown>
    if (!entry || typeof entry !== "object") return `sort[${String(i)}]: must be an object`
    if (typeof entry.field !== "string" || entry.field.length === 0) {
      return `sort[${String(i)}]: needs a field`
    }
    if (entry.direction !== "asc" && entry.direction !== "desc") {
      return `sort[${String(i)}]: direction must be asc or desc`
    }
  }
  return null
}

function assertViewConfig(input: { filters?: unknown; columns?: unknown; sort?: unknown }): void {
  const filterErr = validateSavedViewFilters(input.filters)
  if (filterErr) throw new Error(`saved_views.create: invalid filters: ${filterErr}`)
  const columnsErr = validateSavedViewColumns(input.columns)
  if (columnsErr) throw new Error(`saved_views.create: invalid columns: ${columnsErr}`)
  const sortErr = validateSavedViewSort(input.sort)
  if (sortErr) throw new Error(`saved_views.create: invalid sort: ${sortErr}`)
}

/**
 * Named record-list configurations. listForOwner returns what one user may
 * open for an object: their own views plus workspace-shared ones.
 */
export function createSavedViewsRepository() {
  const base = createBaseRepository(savedViews)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateSavedViewInput,
      actorId?: string,
    ): Promise<SavedView> {
      if (input.objectType.trim().length === 0) {
        throw new Error("saved_views.create: objectType must not be empty")
      }
      if (input.name.trim().length === 0) {
        throw new Error("saved_views.create: name must not be empty")
      }
      assertViewConfig(input)
      const rows = await db
        .insert(savedViews)
        .values({
          workspaceId,
          objectType: input.objectType,
          name: input.name.trim(),
          ownerId: input.ownerId ?? null,
          isShared: input.isShared ?? false,
          filter: input.filters ?? null,
          columns: input.columns ?? null,
          sort: input.sort ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("saved_views.create: insert returned no rows")
      return row
    },

    async listForOwner(
      db: Database,
      workspaceId: string,
      objectType: string,
      ownerId: string,
    ): Promise<SavedView[]> {
      return db
        .select()
        .from(savedViews)
        .where(
          and(
            eq(savedViews.workspaceId, workspaceId),
            eq(savedViews.objectType, objectType),
            or(eq(savedViews.ownerId, ownerId), eq(savedViews.isShared, true)),
            isNull(savedViews.deletedAt),
          ),
        )
        .orderBy(asc(savedViews.name))
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      patch: UpdateSavedViewInput,
      actorId?: string,
    ): Promise<SavedView | null> {
      assertViewConfig(patch)
      const rows = await db
        .update(savedViews)
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
          ...(patch.isShared === undefined ? {} : { isShared: patch.isShared }),
          ...(patch.filters === undefined ? {} : { filter: patch.filters }),
          ...(patch.columns === undefined ? {} : { columns: patch.columns }),
          ...(patch.sort === undefined ? {} : { sort: patch.sort }),
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(
          and(
            eq(savedViews.id, id),
            eq(savedViews.workspaceId, workspaceId),
            isNull(savedViews.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },
  }
}

export type SavedViewsRepository = ReturnType<typeof createSavedViewsRepository>
