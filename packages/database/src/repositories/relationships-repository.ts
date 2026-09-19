import { and, desc, eq, isNull, or } from "drizzle-orm"
import type { Database } from "../client"
import {
  relationships,
  type Relationship,
  type RelationshipMetadata,
} from "../schema/relationships"
import { createBaseRepository } from "./base-repository"

export type CreateRelationshipInput = {
  sourceType: string
  sourceId: string
  targetType: string
  targetId: string
  relationshipType: string
  label?: string | null
  metadata?: RelationshipMetadata | null
}

function nonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) throw new Error(`relationships.create: ${field} must not be empty`)
  return value
}

/**
 * Directed edges between arbitrary records. Removal is a soft delete via the
 * base repository; the partial unique edge index lets a deleted edge be
 * recreated without conflicts.
 */
export function createRelationshipsRepository() {
  const base = createBaseRepository(relationships)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateRelationshipInput,
      actorId?: string,
    ): Promise<Relationship> {
      const sourceType = nonEmpty(input.sourceType, "sourceType")
      const targetType = nonEmpty(input.targetType, "targetType")
      const relationshipType = nonEmpty(input.relationshipType, "relationshipType")
      if (sourceType === targetType && input.sourceId === input.targetId) {
        throw new Error("relationships.create: a record cannot relate to itself")
      }
      const rows = await db
        .insert(relationships)
        .values({
          workspaceId,
          sourceType,
          sourceId: input.sourceId,
          targetType,
          targetId: input.targetId,
          relationshipType,
          label: input.label ?? null,
          metadata: input.metadata ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("relationships.create: insert returned no rows")
      return row
    },

    /** Every live edge touching a record, in either direction, newest first. */
    async listForRecord(
      db: Database,
      workspaceId: string,
      objectType: string,
      recordId: string,
    ): Promise<Relationship[]> {
      return db
        .select()
        .from(relationships)
        .where(
          and(
            eq(relationships.workspaceId, workspaceId),
            or(
              and(eq(relationships.sourceType, objectType), eq(relationships.sourceId, recordId)),
              and(eq(relationships.targetType, objectType), eq(relationships.targetId, recordId)),
            ),
            isNull(relationships.deletedAt),
          ),
        )
        .orderBy(desc(relationships.createdAt))
    },

    /** Live edge for an exact (source, target, type) tuple, if one exists. */
    async findEdge(
      db: Database,
      workspaceId: string,
      sourceType: string,
      sourceId: string,
      targetType: string,
      targetId: string,
      relationshipType: string,
    ): Promise<Relationship | null> {
      const rows = await db
        .select()
        .from(relationships)
        .where(
          and(
            eq(relationships.workspaceId, workspaceId),
            eq(relationships.sourceType, sourceType),
            eq(relationships.sourceId, sourceId),
            eq(relationships.targetType, targetType),
            eq(relationships.targetId, targetId),
            eq(relationships.relationshipType, relationshipType),
            isNull(relationships.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },
  }
}

export type RelationshipsRepository = ReturnType<typeof createRelationshipsRepository>
