import { and, asc, desc, eq, isNull, type SQL } from "drizzle-orm"
import type { PgColumn, PgTableWithColumns } from "drizzle-orm/pg-core"
import type { Database } from "../client"

export type ListOptions = {
  workspaceId: string
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  /** Extra AND conditions (filters) supplied by the domain service. */
  where?: SQL[]
}

/**
 * Structural interface for workspace-scoped business tables. Any Drizzle
 * pgTable exposing the BaseRecord columns (see schema/base.ts) satisfies
 * it — no per-table generics needed, so queries stay fully typed.
 */
export type BaseTable = PgTableWithColumns<{
  name: string
  schema: string | undefined
  columns: {
    id: PgColumn
    workspaceId: PgColumn
    createdAt: PgColumn
    updatedAt: PgColumn
    deletedAt: PgColumn
    updatedBy: PgColumn
  }
  dialect: "pg"
}>

/**
 * Workspace-scoped repository with soft-delete filtering, cursor pagination
 * and audit-ready CRUD. Domain repositories wrap this for concrete tables.
 */
export function createBaseRepository(table: BaseTable) {
  return {
    table,

    async list(db: Database, opts: ListOptions) {
      const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200)
      const ordering = opts.order === "asc" ? asc(table.createdAt) : desc(table.createdAt)
      const conditions: SQL[] = [
        eq(table.workspaceId, opts.workspaceId),
        isNull(table.deletedAt),
        ...(opts.where ?? []),
      ]
      const rows = await db
        .select()
        .from(table)
        .where(and(...conditions))
        .orderBy(ordering)
        .limit(limit + 1)
      const hasMore = rows.length > limit
      const data = hasMore ? rows.slice(0, limit) : rows
      const last = data[data.length - 1] as { id: unknown } | undefined
      const nextCursor = hasMore ? String(last?.id ?? "") : null
      return { data, pagination: { nextCursor, limit } }
    },

    async findById(db: Database, workspaceId: string, id: string) {
      const rows = await db
        .select()
        .from(table)
        .where(and(eq(table.id, id), eq(table.workspaceId, workspaceId), isNull(table.deletedAt)))
        .limit(1)
      return rows[0] ?? null
    },

    async softDelete(db: Database, workspaceId: string, id: string, actorId?: string) {
      const where = and(eq(table.id, id), eq(table.workspaceId, workspaceId))
      if (actorId) {
        await db.update(table).set({ deletedAt: new Date(), updatedBy: actorId }).where(where)
      } else {
        await db.update(table).set({ deletedAt: new Date() }).where(where)
      }
    },

    async restore(db: Database, workspaceId: string, id: string) {
      await db
        .update(table)
        .set({ deletedAt: null })
        .where(and(eq(table.id, id), eq(table.workspaceId, workspaceId)))
    },
  }
}
