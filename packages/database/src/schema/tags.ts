import { isNull, sql } from "drizzle-orm"
import { index, pgTable, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core"
import { baseColumns, workspaceColumn } from "./base"

/**
 * Workspace-scoped labels attachable to any record (people, deals, ...).
 * Names are unique per workspace, case-insensitively: the repository
 * normalizes display casing while the partial unique index on
 * `lower(name)` rejects "VIP" vs "vip" duplicates among live rows.
 */
export const tags = pgTable(
  "tags",
  {
    ...baseColumns,
    ...workspaceColumn,
    name: varchar("name", { length: 128 }).notNull(),
    color: varchar("color", { length: 32 }),
  },
  (t) => [
    index("tags_workspace_idx").on(t.workspaceId),
    uniqueIndex("tags_workspace_name_uidx")
      .on(t.workspaceId, sql`lower(${t.name})`)
      .where(isNull(t.deletedAt)),
  ],
)

export type Tag = typeof tags.$inferSelect
export type NewTag = typeof tags.$inferInsert

/**
 * Polymorphic join between a tag and any business record. `object_type` is
 * the record's object key (e.g. "person", "deal", custom object keys) and
 * `record_id` is its id. Both are PLAIN columns — never foreign keys: the
 * target tables do not exist yet and are created by later module agents.
 */
export const taggables = pgTable(
  "taggables",
  {
    ...baseColumns,
    ...workspaceColumn,
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    objectType: varchar("object_type", { length: 64 }).notNull(),
    recordId: uuid("record_id").notNull(),
  },
  (t) => [
    index("taggables_object_record_idx").on(t.objectType, t.recordId),
    index("taggables_tag_idx").on(t.tagId),
    uniqueIndex("taggables_tag_object_record_uidx")
      .on(t.tagId, t.objectType, t.recordId)
      .where(isNull(t.deletedAt)),
  ],
)

export type Taggable = typeof taggables.$inferSelect
export type NewTaggable = typeof taggables.$inferInsert
