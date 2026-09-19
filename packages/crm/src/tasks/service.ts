import { CrmEvents, createEvent, getEventBus } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import { paginationQuerySchema } from "@yourcrm/validation"
import { z } from "zod"
import type { TaskListResult, TaskRecord, TasksServiceContext, TasksServiceDeps } from "./types"

/**
 * Tasks zod schemas. The service validates inputs with these; API routes
 * reuse them at the HTTP boundary via `@hono/zod-validator`. (People keeps
 * these in a separate `schemas.ts`; tasks co-locates them here so the
 * module stays within its reserved file list.)
 */

const titleSchema = z.string().trim().min(1).max(255)

const dateInputSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: "must be a valid date",
  })
  .nullish()

export const createTaskSchema = z.object({
  title: titleSchema,
  description: z.string().max(10000).nullish(),
  status: z.enum(["open", "in_progress", "completed", "archived"]).nullish(),
  priority: z.enum(["low", "medium", "high", "urgent"]).nullish(),
  dueDate: dateInputSchema,
  assigneeId: z.string().min(1).nullish(),
  ownerId: z.string().min(1).nullish(),
  personId: z.string().min(1).nullish(),
  companyId: z.string().min(1).nullish(),
  dealId: z.string().min(1).nullish(),
})

export type CreateTaskInput = z.infer<typeof createTaskSchema>

export const updateTaskSchema = createTaskSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>

export const taskQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: z.enum(["open", "in_progress", "completed", "archived"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assigneeId: z.string().min(1).optional(),
  mine: z.coerce.boolean().optional(),
  overdue: z.coerce.boolean().optional(),
  dueBefore: z.string().trim().optional(),
  dueAfter: z.string().trim().optional(),
})

export type TaskQuery = z.infer<typeof taskQuerySchema>

export const taskSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  status: z.string(),
  priority: z.string(),
  dueDate: z.unknown().nullable().optional(),
  completedAt: z.unknown().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  personId: z.string().nullable().optional(),
  companyId: z.string().nullable().optional(),
  dealId: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type TaskDto = z.infer<typeof taskSchema>

export class TaskNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`task ${id} not found`)
    this.name = "TaskNotFoundError"
  }
}

function permissionOf(ctx: TasksServiceContext, action: "read" | "create" | "update" | "delete") {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "task",
    action,
  }
}

/**
 * Tasks domain service (mirrors the people golden reference).
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. does the work through the injected `TasksStore` port;
 *  3. emits the domain event via the `CrmEvents` constant (never a literal);
 *  4. writes the audit row with before/after (mutations only).
 */
export function createTasksService(deps: TasksServiceDeps) {
  const events = deps.events ?? getEventBus()

  async function list(ctx: TasksServiceContext, rawQuery: unknown): Promise<TaskListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = taskQuerySchema.parse(rawQuery)
    // `mine` is actor-scoped server-side: resolve it to the caller's id so
    // clients never need to know internal user ids.
    const storeQuery = {
      ...query,
      assigneeId: query.mine === true ? ctx.actorId : query.assigneeId,
    }
    return deps.store.list(ctx.workspaceId, storeQuery)
  }

  async function get(ctx: TasksServiceContext, id: string): Promise<TaskRecord> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findById(ctx.workspaceId, id)
    if (!found) throw new TaskNotFoundError(id)
    return found
  }

  async function create(ctx: TasksServiceContext, rawInput: unknown): Promise<TaskRecord> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createTaskSchema.parse(rawInput)
    const task = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await events.emit(
      createEvent({
        event: CrmEvents.TaskCreated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "task",
        entityId: task.id,
        after: task,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "task",
      recordId: task.id,
      after: task,
      correlationId: ctx.correlationId,
    })
    return task
  }

  async function update(
    ctx: TasksServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<TaskRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateTaskSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new TaskNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new TaskNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.TaskUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "task",
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
      object: "task",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function complete(ctx: TasksServiceContext, id: string): Promise<TaskRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new TaskNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      { status: "completed", completedAt: new Date().toISOString() },
      ctx.actorId,
    )
    if (!after) throw new TaskNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.TaskCompleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "task",
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
      object: "task",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function reopen(ctx: TasksServiceContext, id: string): Promise<TaskRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new TaskNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      { status: "open", completedAt: null },
      ctx.actorId,
    )
    if (!after) throw new TaskNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.TaskUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "task",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "reopen",
      object: "task",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(ctx: TasksServiceContext, id: string): Promise<TaskRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new TaskNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await events.emit(
      createEvent({
        event: CrmEvents.TaskDeleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "task",
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "task",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(ctx: TasksServiceContext, id: string): Promise<TaskRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new TaskNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.TaskUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "task",
        entityId: id,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "task",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  return { list, get, create, update, complete, reopen, softDelete, restore }
}

export type TasksService = ReturnType<typeof createTasksService>
