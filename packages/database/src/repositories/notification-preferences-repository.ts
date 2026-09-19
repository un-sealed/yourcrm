import { and, eq, isNull } from "drizzle-orm"
import type { Database } from "../client"
import { notificationPreferences, type NotificationPreference } from "../schema/system"

export type NotificationPreferencesPatch = {
  categories?: Record<
    string,
    Partial<{ in_app: boolean; email: boolean; push: boolean; sms: boolean }>
  >
  quietHoursEnabled?: boolean
  quietHoursStart?: string | null
  quietHoursEnd?: string | null
  timezone?: string
}

/**
 * One row per (workspace, user) — `notification_preferences_user_uidx`
 * (migration 0370) enforces it. `upsert` merges `categories` shallowly
 * (per-category, so patching one category never drops another) rather than
 * replacing the whole map.
 */
export function createNotificationPreferencesRepository() {
  return {
    table: notificationPreferences,

    async get(
      db: Database,
      workspaceId: string,
      userId: string,
    ): Promise<NotificationPreference | null> {
      const rows = await db
        .select()
        .from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.workspaceId, workspaceId),
            eq(notificationPreferences.userId, userId),
            isNull(notificationPreferences.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    async upsert(
      db: Database,
      workspaceId: string,
      userId: string,
      patch: NotificationPreferencesPatch,
      actorId?: string,
    ): Promise<NotificationPreference> {
      const existing = await this.get(db, workspaceId, userId)
      const mergedCategories = {
        ...((existing?.categories as Record<string, unknown> | null) ?? {}),
        ...(patch.categories ?? {}),
      }
      if (existing) {
        const rows = await db
          .update(notificationPreferences)
          .set({
            categories: mergedCategories,
            ...(patch.quietHoursEnabled === undefined
              ? {}
              : { quietHoursEnabled: patch.quietHoursEnabled }),
            ...(patch.quietHoursStart === undefined
              ? {}
              : { quietHoursStart: patch.quietHoursStart }),
            ...(patch.quietHoursEnd === undefined ? {} : { quietHoursEnd: patch.quietHoursEnd }),
            ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
            updatedAt: new Date(),
            ...(actorId === undefined ? {} : { updatedBy: actorId }),
          })
          .where(eq(notificationPreferences.id, existing.id))
          .returning()
        const row = rows[0]
        if (!row) throw new Error("notification_preferences.upsert: update returned no rows")
        return row
      }
      const rows = await db
        .insert(notificationPreferences)
        .values({
          workspaceId,
          userId,
          categories: mergedCategories,
          quietHoursEnabled: patch.quietHoursEnabled ?? false,
          quietHoursStart: patch.quietHoursStart ?? null,
          quietHoursEnd: patch.quietHoursEnd ?? null,
          timezone: patch.timezone ?? "UTC",
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("notification_preferences.upsert: insert returned no rows")
      return row
    },
  }
}

export type NotificationPreferencesRepository = ReturnType<
  typeof createNotificationPreferencesRepository
>
