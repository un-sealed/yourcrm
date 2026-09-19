import { isNull } from "drizzle-orm"
import { index, jsonb, pgTable, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core"
import { baseColumns, workspaceColumn } from "./base"

/** Free-form metadata carried on a relationship edge (ordering, notes, ...). */
export type RelationshipMetadata = Record<string, unknown>

/**
 * Directed edge between any two business records (default or custom
 * objects). All four endpoint columns are PLAIN columns — never foreign
 * keys: the tables they point at do not exist yet and are created by later
 * module agents. Query one side via the (source_type, source_id) /
 * (target_type, target_id) indexes. The partial unique index keeps a single
 * live edge per (source, target, type) tuple; reciprocal display ("A employs
 * B" vs "B works at A") is a presentation concern for domain services.
 */
export const relationships = pgTable(
  "relationships",
  {
    ...baseColumns,
    ...workspaceColumn,
    sourceType: varchar("source_type", { length: 64 }).notNull(),
    sourceId: uuid("source_id").notNull(),
    targetType: varchar("target_type", { length: 64 }).notNull(),
    targetId: uuid("target_id").notNull(),
    relationshipType: varchar("relationship_type", { length: 64 }).notNull(),
    label: varchar("label", { length: 255 }),
    metadata: jsonb("metadata").$type<RelationshipMetadata | null>(),
  },
  (t) => [
    index("relationships_source_idx").on(t.sourceType, t.sourceId),
    index("relationships_target_idx").on(t.targetType, t.targetId),
    index("relationships_type_idx").on(t.relationshipType),
    uniqueIndex("relationships_edge_uidx")
      .on(t.workspaceId, t.sourceType, t.sourceId, t.targetType, t.targetId, t.relationshipType)
      .where(isNull(t.deletedAt)),
  ],
)

export type Relationship = typeof relationships.$inferSelect
export type NewRelationship = typeof relationships.$inferInsert
