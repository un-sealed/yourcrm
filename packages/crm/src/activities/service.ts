import { CrmEvents, createEvent, getEventBus } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import { paginationQuerySchema } from "@yourcrm/validation"
import { z } from "zod"
import type {
  ActivitiesServiceContext,
  ActivitiesServiceDeps,
  ActivityListResult,
  ActivityRecord,
} from "./types"

/**
 * Activities zod schemas. Services validate inputs with these; API routes
 * reuse them at the HTTP boundary via `@hono/zod-validator`. (People keeps
 * these in a separate `schemas.ts`; activities co-locates them here so the
 * module stays within its assigned file list — same shapes, same role.)
 */

export const ACTIVITY_TYPES = ["note", "call", "meeting", "email"] as const
export const ACTIVITY_STATUSES = ["open", "completed", "cancelled"] as const
export const ACTIVITY_SUBJECT_TYPES = ["person", "company", "deal", "lead"] as const

export const createActivitySchema = z.object({
  title: z.string().trim().min(1).max(255),
  type: z.enum(ACTIVITY_TYPES).nullish(),
  subjectType: z.enum(ACTIVITY_SUBJECT_TYPES).nullish(),
  subjectId: z.string().min(1).nullish(),
  body: z.string().max(10000).nullish(),
  status: z.enum(ACTIVITY_STATUSES).nullish(),
  ownerId: z.string().min(1).nullish(),
  dueAt: z.string().max(64).nullish(),
})

export type CreateActivityInput = z.infer<typeof createActivitySchema>

export const updateActivitySchema = createActivitySchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateActivityInput = z.infer<typeof updateActivitySchema>

export const activityQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  type: z.enum(ACTIVITY_TYPES).optional(),
  status: z.enum(ACTIVITY_STATUSES).optional(),
  subjectType: z.enum(ACTIVITY_SUBJECT_TYPES).optional(),
  subjectId: z.string().min(1).optional(),
})

export type ActivityQuery = z.infer<typeof activityQuerySchema>

export const activityTimelineQuerySchema = paginationQuerySchema.extend({
  subjectType: z.enum(ACTIVITY_SUBJECT_TYPES),
  subjectId: z.string().min(1),
})

export type ActivityTimelineQuery = z.infer<typeof activityTimelineQuerySchema>

export const activitySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  type: z.string(),
  subjectType: z.string().nullable().optional(),
  subjectId: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  status: z.string(),
  ownerId: z.string().nullable().optional(),
  dueAt: z.unknown(),
  completedAt: z.unknown(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type ActivityDto = z.infer<typeof activitySchema>

export class ActivityNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`activity ${id} not found`)
    this.name = "ActivityNotFoundError"
  }
}

function permissionOf(
  ctx: ActivitiesServiceContext,
  action: "read" | "create" | "update" | "delete",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "activity",
    action,
  }
}

/**
 * Activities domain service (mirrors the people golden reference).
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. does the work through the injected `ActivitiesStore` port;
 *  3. emits the domain event via the `CrmEvents` constant (never a literal);
 *  4. writes the audit row with before/after (mutations only).
 */
export function createActivitiesService(deps: ActivitiesServiceDeps) {
  const events = deps.events ?? getEventBus()

  async function list(
    ctx: ActivitiesServiceContext,
    rawQuery: unknown,
  ): Promise<ActivityListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = activityQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  /**
   * Reusable timeline query so other modules can render a record feed
   * without touching the activities table directly.
   */
  async function timeline(
    ctx: ActivitiesServiceContext,
    rawQuery: unknown,
  ): Promise<ActivityListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = activityTimelineQuerySchema.parse(rawQuery)
    return deps.store.timeline(ctx.workspaceId, query)
  }

  async function get(ctx: ActivitiesServiceContext, id: string): Promise<ActivityRecord> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findById(ctx.workspaceId, id)
    if (!found) throw new ActivityNotFoundError(id)
    return found
  }

  async function create(ctx: ActivitiesServiceContext, rawInput: unknown): Promise<ActivityRecord> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createActivitySchema.parse(rawInput)
    const activity = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await events.emit(
      createEvent({
        event: CrmEvents.ActivityCreated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "activity",
        entityId: activity.id,
        after: activity,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "activity",
      recordId: activity.id,
      after: activity,
      correlationId: ctx.correlationId,
    })
    return activity
  }

  async function update(
    ctx: ActivitiesServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<ActivityRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateActivitySchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new ActivityNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new ActivityNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.ActivityUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "activity",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "activity",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function complete(ctx: ActivitiesServiceContext, id: string): Promise<ActivityRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new ActivityNotFoundError(id)
    const after = await deps.store.complete(ctx.workspaceId, id, ctx.actorId)
    if (!after) throw new ActivityNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.ActivityCompleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "activity",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "complete",
      object: "activity",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(ctx: ActivitiesServiceContext, id: string): Promise<ActivityRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new ActivityNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await events.emit(
      createEvent({
        event: CrmEvents.ActivityDeleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "activity",
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "activity",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(ctx: ActivitiesServiceContext, id: string): Promise<ActivityRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new ActivityNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.ActivityUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "activity",
        entityId: id,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "activity",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  return { list, timeline, get, create, update, complete, softDelete, restore }
}

export type ActivitiesService = ReturnType<typeof createActivitiesService>
