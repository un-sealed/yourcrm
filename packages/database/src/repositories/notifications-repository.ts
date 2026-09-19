import { and, desc, eq, isNull, sql } from "drizzle-orm"
import type { Database } from "../client"
import { notifications, type Notification } from "../schema/system"
import { createBaseRepository } from "./base-repository"

export type CreateNotificationInput = {
  userId: string
  type: string
  title: string
  body?: string | null
}

export type NotificationListOptions = {
  workspaceId: string
  userId: string
  limit?: number
  cursor?: string
  unreadOnly?: boolean
}

export type NotificationListResult = {
  data: Notification[]
  pagination: { nextCursor: string | null; limit: number }
}

/**
 * Workspace + user scoped notifications repository (spec 43-notifications,
 * P0, migration 0370). Every read/write below filters on BOTH
 * `workspace_id` AND `user_id` — a user only ever sees their own
 * notifications. `findById`/`markRead`/`softDelete` for a notification that
 * belongs to someone else in the same workspace return null/no-op exactly
 * like an unknown id, so the service maps it to 404, never leaking that a
 * record with that id exists for a different user.
 *
 * Cursor pagination mirrors every other P0 repository (`nextCursor` signals
 * "more rows exist"; it is not yet a keyset offset — see
 * `base-repository.ts`).
 */
export function createNotificationsRepository() {
  const base = createBaseRepository(notifications)

  return {
    ...base,

    /** Unread-first, then newest-first — the in-app notification center order. */
    async list(db: Database, opts: NotificationListOptions): Promise<NotificationListResult> {
      const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200)
      const conditions = [
        eq(notifications.workspaceId, opts.workspaceId),
        eq(notifications.userId, opts.userId),
        isNull(notifications.deletedAt),
      ]
      if (opts.unreadOnly) conditions.push(isNull(notifications.readAt))
      const rows = await db
        .select()
        .from(notifications)
        .where(and(...conditions))
        .orderBy(desc(sql`${notifications.readAt} is null`), desc(notifications.createdAt))
        .limit(limit + 1)
      const hasMore = rows.length > limit
      const data = hasMore ? rows.slice(0, limit) : rows
      const last = data[data.length - 1]
      return { data, pagination: { nextCursor: hasMore ? (last?.id ?? null) : null, limit } }
    },

    async countUnread(db: Database, workspaceId: string, userId: string): Promise<number> {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(
          and(
            eq(notifications.workspaceId, workspaceId),
            eq(notifications.userId, userId),
            isNull(notifications.deletedAt),
            isNull(notifications.readAt),
          ),
        )
      return rows[0]?.count ?? 0
    },

    async findById(
      db: Database,
      workspaceId: string,
      userId: string,
      id: string,
    ): Promise<Notification | null> {
      const rows = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.workspaceId, workspaceId),
            eq(notifications.userId, userId),
            isNull(notifications.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    async create(
      db: Database,
      workspaceId: string,
      input: CreateNotificationInput,
      actorId?: string,
    ): Promise<Notification> {
      const title = input.title.trim()
      if (title === "") throw new Error("notifications.create: title must not be empty")
      const rows = await db
        .insert(notifications)
        .values({
          workspaceId,
          userId: input.userId,
          type: input.type,
          title: title.slice(0, 255),
          body: input.body ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("notifications.create: insert returned no rows")
      return row
    },

    /**
     * Idempotent: `readAt` is set via `COALESCE`, so repeated calls keep the
     * original timestamp and keep returning the same row — never an error
     * and never a second "read" transition.
     */
    async markRead(
      db: Database,
      workspaceId: string,
      userId: string,
      id: string,
    ): Promise<Notification | null> {
      const rows = await db
        .update(notifications)
        .set({
          readAt: sql`coalesce(${notifications.readAt}, now())`,
          updatedAt: new Date(),
          updatedBy: userId,
        })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.workspaceId, workspaceId),
            eq(notifications.userId, userId),
            isNull(notifications.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async markAllRead(
      db: Database,
      workspaceId: string,
      userId: string,
    ): Promise<{ updated: number }> {
      const rows = await db
        .update(notifications)
        .set({
          readAt: sql`coalesce(${notifications.readAt}, now())`,
          updatedAt: new Date(),
          updatedBy: userId,
        })
        .where(
          and(
            eq(notifications.workspaceId, workspaceId),
            eq(notifications.userId, userId),
            isNull(notifications.deletedAt),
            isNull(notifications.readAt),
          ),
        )
        .returning({ id: notifications.id })
      return { updated: rows.length }
    },

    async softDelete(
      db: Database,
      workspaceId: string,
      userId: string,
      id: string,
      actorId?: string,
    ): Promise<void> {
      await db
        .update(notifications)
        .set({ deletedAt: new Date(), ...(actorId === undefined ? {} : { updatedBy: actorId }) })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.workspaceId, workspaceId),
            eq(notifications.userId, userId),
            isNull(notifications.deletedAt),
          ),
        )
    },
  }
}

export type NotificationsRepository = ReturnType<typeof createNotificationsRepository>
