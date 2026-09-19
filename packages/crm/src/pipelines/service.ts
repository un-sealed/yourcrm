import { PipelineEvents, createEvent, getEventBus } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import { paginationQuerySchema } from "@yourcrm/validation"
import { z } from "zod"
import type {
  PipelineListResult,
  PipelineRecord,
  PipelineStageRecord,
  PipelineWithStages,
  PipelinesServiceContext,
  PipelinesServiceDeps,
} from "./types"

// ---------------------------------------------------------------------------
// Zod schemas (services validate inputs with these; API routes reuse them at
// the HTTP boundary via `@hono/zod-validator`).
//
// NOTE: People keeps these in a separate `schemas.ts`; the pipelines file
// budget has no `schemas.ts` slot, so they live here and are re-exported
// from `index.ts` under the same names.
// ---------------------------------------------------------------------------

const nameSchema = z.string().trim().min(1).max(255)

export const pipelineStageInputSchema = z.object({
  name: nameSchema,
  color: z.string().trim().max(32).nullish(),
  position: z.number().int().min(0).nullish(),
  probability: z.number().int().min(0).max(100).default(0),
  isWon: z.boolean().default(false),
  isLost: z.boolean().default(false),
})

const createPipelineBase = z.object({
  name: nameSchema,
  description: z.string().trim().max(10000).nullish(),
  ownerId: z.string().min(1).nullish(),
  status: z.enum(["active", "archived"]).nullish(),
  isDefault: z.boolean().default(false),
  stages: z.array(pipelineStageInputSchema).max(50).default([]),
})

export const createPipelineSchema = createPipelineBase.refine(
  (value: z.infer<typeof createPipelineBase>) =>
    !value.stages.some((stage) => stage.isWon === true && stage.isLost === true),
  { message: "a stage cannot be both won and lost" },
)

export type CreatePipelineInput = z.infer<typeof createPipelineSchema>

export const updatePipelineSchema = createPipelineBase
  .omit({ stages: true })
  .partial()
  .refine((value: Record<string, unknown>) => Object.keys(value).length > 0, {
    message: "patch must not be empty",
  })

export type UpdatePipelineInput = z.infer<typeof updatePipelineSchema>

export const createStageSchema = pipelineStageInputSchema.omit({ position: true })

export type CreateStageInput = z.infer<typeof createStageSchema>

export const updateStageSchema = createStageSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateStageInput = z.infer<typeof updateStageSchema>

export const reorderStagesSchema = z.object({
  order: z.array(z.string().min(1)).min(1).max(50),
})

export type ReorderStagesInput = z.infer<typeof reorderStagesSchema>

export const pipelineQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: z.enum(["active", "archived"]).optional(),
})

export type PipelineQuery = z.infer<typeof pipelineQuerySchema>

export const pipelineSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  status: z.string(),
  isDefault: z.boolean().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type PipelineDto = z.infer<typeof pipelineSchema>

export const pipelineStageSchema = z.object({
  id: z.string(),
  pipelineId: z.string(),
  name: z.string(),
  color: z.string().nullable().optional(),
  position: z.number(),
  probability: z.number(),
  isWon: z.boolean(),
  isLost: z.boolean(),
})

export type PipelineStageDto = z.infer<typeof pipelineStageSchema>

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PipelineNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`pipeline ${id} not found`)
    this.name = "PipelineNotFoundError"
  }
}

export class PipelineStageNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`pipeline stage ${id} not found`)
    this.name = "PipelineStageNotFoundError"
  }
}

function permissionOf(
  ctx: PipelinesServiceContext,
  action: "read" | "create" | "update" | "delete",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "pipeline",
    action,
  }
}

/**
 * Pipelines domain service (mirrors `people/service.ts`).
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. does the work through the injected `PipelinesStore` port;
 *  3. emits the domain event via the `PipelineEvents` constant (never a literal);
 *  4. writes the audit row with before/after (mutations only).
 *
 * Stage mutations reuse `PipelineUpdated` (no stage-specific constants exist
 * in `@yourcrm/events`); only drag-to-reorder persistence emits
 * `PipelineStageReordered`.
 */
export function createPipelinesService(deps: PipelinesServiceDeps) {
  const events = deps.events ?? getEventBus()

  async function emitAndAudit(input: {
    event: string
    ctx: PipelinesServiceContext
    entityId: string
    action: string
    before?: unknown
    after?: unknown
  }): Promise<void> {
    await events.emit(
      createEvent({
        event: input.event,
        workspaceId: input.ctx.workspaceId,
        actorId: input.ctx.actorId,
        entityType: "pipeline",
        entityId: input.entityId,
        before: input.before,
        after: input.after,
        correlationId: input.ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: input.ctx.workspaceId,
      actorId: input.ctx.actorId,
      action: input.action,
      object: "pipeline",
      recordId: input.entityId,
      before: input.before,
      after: input.after,
      correlationId: input.ctx.correlationId,
    })
  }

  async function list(
    ctx: PipelinesServiceContext,
    rawQuery: unknown,
  ): Promise<PipelineListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = pipelineQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(ctx: PipelinesServiceContext, id: string): Promise<PipelineWithStages> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findWithStages(ctx.workspaceId, id)
    if (!found) throw new PipelineNotFoundError(id)
    return found
  }

  async function create(
    ctx: PipelinesServiceContext,
    rawInput: unknown,
  ): Promise<PipelineWithStages> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createPipelineSchema.parse(rawInput)
    const created = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await emitAndAudit({
      event: PipelineEvents.PipelineCreated,
      ctx,
      entityId: created.pipeline.id,
      action: "create",
      after: created,
    })
    return created
  }

  /**
   * Seed helper so the Deals module has something to point at: returns the
   * workspace's existing pipelines untouched, otherwise creates the default
   * sales pipeline from `DEFAULT_SALES_PIPELINE`.
   */
  async function ensureDefault(ctx: PipelinesServiceContext): Promise<PipelineWithStages> {
    requirePermission(permissionOf(ctx, "create"))
    const existing = await deps.store.list(ctx.workspaceId, { limit: 1 })
    const first = existing.data[0]
    if (first) {
      const found = await deps.store.findWithStages(ctx.workspaceId, first.id)
      if (found) return found
    }
    const created = await deps.store.createDefault(ctx.workspaceId, ctx.actorId)
    await emitAndAudit({
      event: PipelineEvents.PipelineCreated,
      ctx,
      entityId: created.pipeline.id,
      action: "create",
      after: created,
    })
    return created
  }

  async function update(
    ctx: PipelinesServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<PipelineRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updatePipelineSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new PipelineNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new PipelineNotFoundError(id)
    await emitAndAudit({
      event: PipelineEvents.PipelineUpdated,
      ctx,
      entityId: id,
      action: "update",
      before,
      after,
    })
    return after
  }

  async function softDelete(ctx: PipelinesServiceContext, id: string): Promise<PipelineRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new PipelineNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await emitAndAudit({
      event: PipelineEvents.PipelineUpdated,
      ctx,
      entityId: id,
      action: "delete",
      before,
    })
    return before
  }

  async function restore(ctx: PipelinesServiceContext, id: string): Promise<PipelineRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new PipelineNotFoundError(id)
    await emitAndAudit({
      event: PipelineEvents.PipelineUpdated,
      ctx,
      entityId: id,
      action: "restore",
      after,
    })
    return after
  }

  async function addStage(
    ctx: PipelinesServiceContext,
    pipelineId: string,
    rawInput: unknown,
  ): Promise<PipelineStageRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const input = createStageSchema.parse(rawInput)
    const stage = await deps.store.addStage(
      ctx.workspaceId,
      pipelineId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    if (!stage) throw new PipelineNotFoundError(pipelineId)
    await emitAndAudit({
      event: PipelineEvents.PipelineUpdated,
      ctx,
      entityId: pipelineId,
      action: "stage_create",
      after: stage,
    })
    return stage
  }

  async function updateStage(
    ctx: PipelinesServiceContext,
    pipelineId: string,
    stageId: string,
    rawPatch: unknown,
  ): Promise<PipelineStageRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateStageSchema.parse(rawPatch)
    const before = await get(ctx, pipelineId)
    const existing = before.stages.find((s) => s.id === stageId)
    if (!existing) throw new PipelineStageNotFoundError(stageId)
    const after = await deps.store.updateStage(
      ctx.workspaceId,
      pipelineId,
      stageId,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new PipelineStageNotFoundError(stageId)
    await emitAndAudit({
      event: PipelineEvents.PipelineUpdated,
      ctx,
      entityId: pipelineId,
      action: "stage_update",
      before: existing,
      after,
    })
    return after
  }

  async function removeStage(
    ctx: PipelinesServiceContext,
    pipelineId: string,
    stageId: string,
  ): Promise<void> {
    requirePermission(permissionOf(ctx, "update"))
    const before = await get(ctx, pipelineId)
    const existing = before.stages.find((s) => s.id === stageId)
    if (!existing) throw new PipelineStageNotFoundError(stageId)
    await deps.store.removeStage(ctx.workspaceId, pipelineId, stageId)
    await emitAndAudit({
      event: PipelineEvents.PipelineUpdated,
      ctx,
      entityId: pipelineId,
      action: "stage_delete",
      before: existing,
    })
  }

  async function reorderStages(
    ctx: PipelinesServiceContext,
    pipelineId: string,
    rawInput: unknown,
  ): Promise<PipelineStageRecord[]> {
    requirePermission(permissionOf(ctx, "update"))
    const input = reorderStagesSchema.parse(rawInput)
    const before = await get(ctx, pipelineId)
    const stages = await deps.store.reorderStages(
      ctx.workspaceId,
      pipelineId,
      input.order,
      ctx.actorId,
    )
    await emitAndAudit({
      event: PipelineEvents.PipelineStageReordered,
      ctx,
      entityId: pipelineId,
      action: "stage_reorder",
      before: before.stages.map((s) => s.id),
      after: stages.map((s) => s.id),
    })
    return stages
  }

  return {
    list,
    get,
    create,
    ensureDefault,
    update,
    softDelete,
    restore,
    addStage,
    updateStage,
    removeStage,
    reorderStages,
  }
}

export type PipelinesService = ReturnType<typeof createPipelinesService>
