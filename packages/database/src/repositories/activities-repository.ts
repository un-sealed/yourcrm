import { and, eq, ilike, isNull, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  activities,
  isActivityStatus,
  isActivitySubjectType,
  isActivityType,
  type Activity,
  type NewActivity,
} from "../schema/activities"
import { createBaseRepository } from "./base-repository"

export type CreateActivityInput = {
  title: string
  type?: string | null
  subjectType?: string | null
  subjectId?: string | null
  body?: string | null
  status?: string | null
  ownerId?: string | null
  dueAt?: Date | string | null
}

export type UpdateActivityInput = Partial<
  Pick<
    NewActivity,
    "title" | "subjectType" | "subjectId" | "body" | "ownerId" | "dueAt" | "completedAt"
  >
> & {
  type?: string | null
  status?: string | null
}

/** Trimmed, non-empty title (max 255, mirrors the column). */
export function normalizeActivityTitle(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("activities.create: title must not be empty")
  if (trimmed.length > 255)
    throw new Error("activities.create: title must be at most 255 characters")
  return trimmed
}

function toActivityValues(
  workspaceId: string,
  input: CreateActivityInput | UpdateActivityInput,
  actorId?: string,
): Partial<NewActivity> {
  const values: Partial<NewActivity> = {}
  if (input.title !== undefined) values.title = normalizeActivityTitle(input.title)
  if (input.type !== undefined) {
    if (input.type !== null && !isActivityType(input.type)) {
      throw new Error("activities.create: type must be one of note, call, meeting, email")
    }
    values.type = input.type ?? "note"
  }
  if (input.subjectType !== undefined) {
    if (input.subjectType !== null && !isActivitySubjectType(input.subjectType)) {
      throw new Error("activities.create: subjectType must be one of person, company, deal, lead")
    }
    values.subjectType = input.subjectType
  }
  if (input.subjectId !== undefined) values.subjectId = input.subjectId
  if (input.body !== undefined) values.body = input.body
  if (input.status !== undefined) {
    if (input.status !== null && !isActivityStatus(input.status)) {
      throw new Error("activities.create: status must be one of open, completed, cancelled")
    }
    values.status = input.status ?? "open"
  }
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.dueAt !== undefined) {
    values.dueAt = input.dueAt === null ? null : new Date(input.dueAt)
  }
  if (actorId !== undefined) {
    values.updatedBy = actorId
  }
  return { ...values, workspaceId }
}

/**
 * Workspace-scoped activities. `subject_type` + `subject_id` stay plain
 * columns (no join here) until cross-module foreign keys land; the
 * `timeline` query is the reusable seam other modules render their feed
 * from.
 */
export function createActivitiesRepository() {
  const base = createBaseRepository(activities)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateActivityInput,
      actorId?: string,
    ): Promise<Activity> {
      const rows = await db
        .insert(activities)
        .values({
          ...toActivityValues(workspaceId, input, actorId),
          workspaceId,
          title: normalizeActivityTitle(input.title),
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("activities.create: insert returned no rows")
      return row
    },

    /** Cursor-paginated list with optional text/type/status/subject search. */
    async search(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" } & {
        query?: string
        type?: string
        status?: string
        subjectType?: string
        subjectId?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const textMatch = or(ilike(activities.title, q), ilike(activities.body, q))
        if (textMatch) conditions.push(textMatch)
      }
      if (opts.type) {
        if (!isActivityType(opts.type)) throw new Error("activities.search: unknown type filter")
        conditions.push(eq(activities.type, opts.type))
      }
      if (opts.status) {
        if (!isActivityStatus(opts.status))
          throw new Error("activities.search: unknown status filter")
        conditions.push(eq(activities.status, opts.status))
      }
      if (opts.subjectType) {
        if (!isActivitySubjectType(opts.subjectType)) {
          throw new Error("activities.search: unknown subjectType filter")
        }
        conditions.push(eq(activities.subjectType, opts.subjectType))
      }
      if (opts.subjectId) {
        conditions.push(eq(activities.subjectId, opts.subjectId))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as Activity[], pagination: result.pagination }
    },

    /**
     * Reusable timeline query: cursor-paginated activities for one subject,
     * newest first by default. Other modules render their record feed from
     * this — they never query the activities table directly.
     */
    async timeline(
      db: Database,
      opts: {
        workspaceId: string
        subjectType: string
        subjectId: string
        limit?: number
        cursor?: string
        order?: "asc" | "desc"
      },
    ) {
      if (!isActivitySubjectType(opts.subjectType)) {
        throw new Error("activities.timeline: unknown subjectType")
      }
      const result = await base.list(db, {
        workspaceId: opts.workspaceId,
        limit: opts.limit,
        cursor: opts.cursor,
        order: opts.order ?? "desc",
        where: [
          eq(activities.subjectType, opts.subjectType),
          eq(activities.subjectId, opts.subjectId),
        ],
      })
      return { data: result.data as Activity[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateActivityInput,
      actorId?: string,
    ): Promise<Activity | null> {
      const rows = await db
        .update(activities)
        .set({ ...toActivityValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(activities.id, id),
            eq(activities.workspaceId, workspaceId),
            isNull(activities.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<Activity | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full Activity shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as Activity | null) ?? null
    },

    /** Mark an activity completed: status + completedAt in one write. */
    async complete(
      db: Database,
      workspaceId: string,
      id: string,
      actorId?: string,
    ): Promise<Activity | null> {
      const rows = await db
        .update(activities)
        .set({
          status: "completed",
          completedAt: new Date(),
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(
          and(
            eq(activities.id, id),
            eq(activities.workspaceId, workspaceId),
            isNull(activities.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },
  }
}

export type ActivitiesRepository = ReturnType<typeof createActivitiesRepository>
