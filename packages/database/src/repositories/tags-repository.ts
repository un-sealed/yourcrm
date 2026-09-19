import { and, eq, getTableColumns, isNull } from "drizzle-orm"
import type { Database } from "../client"
import { taggables, tags, type Tag } from "../schema/tags"
import { createBaseRepository } from "./base-repository"

export type CreateTagInput = {
  name: string
  color?: string | null
}

const HEX_COLOR = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/

/** Display name kept as typed (trimmed); uniqueness is case-insensitive. */
export function normalizeTagName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("tags.create: name must not be empty")
  if (trimmed.length > 128) throw new Error("tags.create: name must be at most 128 characters")
  return trimmed
}

export function validateTagColor(color: string | null | undefined): string | null {
  if (color === undefined || color === null) return null
  if (!HEX_COLOR.test(color)) {
    throw new Error("tags.create: color must be a hex value like #6366F1")
  }
  return color
}

/**
 * Workspace-scoped tags + polymorphic taggables. Detaching is a soft delete
 * so re-attaching the same tag restores the original row.
 */
export function createTagsRepository() {
  const base = createBaseRepository(tags)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateTagInput,
      actorId?: string,
    ): Promise<Tag> {
      const rows = await db
        .insert(tags)
        .values({
          workspaceId,
          name: normalizeTagName(input.name),
          color: validateTagColor(input.color),
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("tags.create: insert returned no rows")
      return row
    },

    /** Every live tag on a record, independent of which module owns the record. */
    async listByRecord(
      db: Database,
      workspaceId: string,
      objectType: string,
      recordId: string,
    ): Promise<Tag[]> {
      return db
        .select({ ...getTableColumns(tags) })
        .from(taggables)
        .innerJoin(tags, eq(taggables.tagId, tags.id))
        .where(
          and(
            eq(taggables.workspaceId, workspaceId),
            eq(taggables.objectType, objectType),
            eq(taggables.recordId, recordId),
            isNull(taggables.deletedAt),
            isNull(tags.deletedAt),
          ),
        )
    },

    /** Idempotent: restores a soft-deleted link, otherwise inserts (or no-ops). */
    async attach(
      db: Database,
      workspaceId: string,
      tagId: string,
      objectType: string,
      recordId: string,
      actorId?: string,
    ) {
      const scope = and(
        eq(taggables.workspaceId, workspaceId),
        eq(taggables.tagId, tagId),
        eq(taggables.objectType, objectType),
        eq(taggables.recordId, recordId),
      )
      const restored = await db
        .update(taggables)
        .set({
          deletedAt: null,
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(scope)
        .returning()
      const existing = restored[0]
      if (existing) return existing
      const rows = await db
        .insert(taggables)
        .values({
          workspaceId,
          tagId,
          objectType,
          recordId,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .onConflictDoNothing()
        .returning()
      return rows[0] ?? null
    },

    /** Soft-deletes the tag link; the tag itself is untouched. */
    async detach(
      db: Database,
      workspaceId: string,
      tagId: string,
      objectType: string,
      recordId: string,
    ): Promise<void> {
      await db
        .update(taggables)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(taggables.workspaceId, workspaceId),
            eq(taggables.tagId, tagId),
            eq(taggables.objectType, objectType),
            eq(taggables.recordId, recordId),
            isNull(taggables.deletedAt),
          ),
        )
    },
  }
}

export type TagsRepository = ReturnType<typeof createTagsRepository>
