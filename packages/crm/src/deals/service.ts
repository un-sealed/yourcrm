import { CrmEvents, createEvent, getEventBus } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import { paginationQuerySchema } from "@yourcrm/validation"
import { z } from "zod"
import type { DealsServiceContext, DealsServiceDeps, DealListResult, DealRecord } from "./types"

/**
 * Deals zod schemas. The service validates inputs with these; API routes
 * reuse them at the HTTP boundary via `@hono/zod-validator`.
 *
 * (Lives in `service.ts` rather than a separate `schemas.ts` so the module
 * stays within its reserved file list; `index.ts` re-exports everything
 * route and test code needs.)
 */

const nameSchema = z.string().trim().min(1).max(255)

const uuidLike = z.string().min(1)

export const dealStageSchema = z.enum([
  "qualification",
  "discovery",
  "proposal",
  "negotiation",
  "won",
  "lost",
])

export type DealStageInput = z.infer<typeof dealStageSchema>

const closeDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expectedCloseDate must be YYYY-MM-DD")
  .nullish()

export const createDealSchema = z.object({
  name: nameSchema,
  amount: z.number().finite().min(0).max(999999999999).nullish(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter code")
    .nullish(),
  pipelineId: uuidLike.nullish(),
  stageId: uuidLike.nullish(),
  stage: dealStageSchema.nullish(),
  probability: z.number().int().min(0).max(100).nullish(),
  expectedCloseDate: closeDateSchema,
  personId: uuidLike.nullish(),
  companyId: uuidLike.nullish(),
  ownerId: uuidLike.nullish(),
  closeReason: z.string().trim().max(255).nullish(),
  notes: z.string().max(10000).nullish(),
})

export type CreateDealInput = z.infer<typeof createDealSchema>

/**
 * Stage moves go through `changeStage`, never through a generic patch, so
 * every transition emits `deal.stage_changed`.
 */
export const updateDealSchema = createDealSchema
  .omit({ stage: true, stageId: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateDealInput = z.infer<typeof updateDealSchema>

export const changeDealStageSchema = z.object({
  stage: dealStageSchema,
  stageId: uuidLike.nullish(),
})

export type ChangeDealStageInput = z.infer<typeof changeDealStageSchema>

export const closeDealSchema = z.object({
  closeReason: z.string().trim().max(255).nullish(),
})

export type CloseDealInput = z.infer<typeof closeDealSchema>

export const dealQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  stage: dealStageSchema.optional(),
  pipelineId: uuidLike.optional(),
  sort: z.enum(["name", "amount", "expectedCloseDate", "createdAt"]).optional(),
})

export type DealQuery = z.infer<typeof dealQuerySchema>

export const dealSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  amount: z.unknown().nullable().optional(),
  currency: z.string(),
  pipelineId: z.string().nullable().optional(),
  stageId: z.string().nullable().optional(),
  stage: z.string(),
  probability: z.number().nullable().optional(),
  expectedCloseDate: z.unknown().nullable().optional(),
  personId: z.string().nullable().optional(),
  companyId: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  closeReason: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type DealDto = z.infer<typeof dealSchema>

export class DealNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`deal ${id} not found`)
    this.name = "DealNotFoundError"
  }
}

function permissionOf(ctx: DealsServiceContext, action: "read" | "create" | "update" | "delete") {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "deal",
    action,
  }
}

/** Weighted value (amount * probability / 100), derived — never stored. */
export function weightedValue(
  amount: string | number | null | undefined,
  probability: number | null | undefined,
): number | null {
  if (
    amount === null ||
    amount === undefined ||
    probability === null ||
    probability === undefined
  ) {
    return null
  }
  const num = typeof amount === "number" ? amount : Number(amount)
  if (!Number.isFinite(num)) return null
  return Math.round(num * (probability / 100) * 100) / 100
}

/**
 * Deals domain service (mirrors the people golden reference).
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. does the work through the injected `DealsStore` port;
 *  3. emits the domain event via the `CrmEvents` constant (never a literal);
 *  4. writes the audit row with before/after (mutations only).
 */
export function createDealsService(deps: DealsServiceDeps) {
  const events = deps.events ?? getEventBus()

  async function list(ctx: DealsServiceContext, rawQuery: unknown): Promise<DealListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = dealQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(ctx: DealsServiceContext, id: string): Promise<DealRecord> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findById(ctx.workspaceId, id)
    if (!found) throw new DealNotFoundError(id)
    return found
  }

  async function create(ctx: DealsServiceContext, rawInput: unknown): Promise<DealRecord> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createDealSchema.parse(rawInput)
    const deal = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await events.emit(
      createEvent({
        event: CrmEvents.DealCreated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "deal",
        entityId: deal.id,
        after: deal,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "deal",
      recordId: deal.id,
      after: deal,
      correlationId: ctx.correlationId,
    })
    return deal
  }

  async function update(
    ctx: DealsServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<DealRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateDealSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new DealNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new DealNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.DealUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "deal",
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
      object: "deal",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function changeStage(
    ctx: DealsServiceContext,
    id: string,
    rawInput: unknown,
  ): Promise<DealRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const input = changeDealStageSchema.parse(rawInput)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new DealNotFoundError(id)
    const after = await deps.store.changeStage(
      ctx.workspaceId,
      id,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new DealNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.DealStageChanged,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "deal",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "stage_changed",
      object: "deal",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function markWon(
    ctx: DealsServiceContext,
    id: string,
    rawInput: unknown,
  ): Promise<DealRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const input = closeDealSchema.parse(rawInput ?? {})
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new DealNotFoundError(id)
    const after = await deps.store.close(
      ctx.workspaceId,
      id,
      { ...(input as Record<string, unknown>), stage: "won" },
      ctx.actorId,
    )
    if (!after) throw new DealNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.DealWon,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "deal",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "won",
      object: "deal",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function markLost(
    ctx: DealsServiceContext,
    id: string,
    rawInput: unknown,
  ): Promise<DealRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const input = closeDealSchema.parse(rawInput ?? {})
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new DealNotFoundError(id)
    const after = await deps.store.close(
      ctx.workspaceId,
      id,
      { ...(input as Record<string, unknown>), stage: "lost" },
      ctx.actorId,
    )
    if (!after) throw new DealNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.DealLost,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "deal",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "lost",
      object: "deal",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(ctx: DealsServiceContext, id: string): Promise<DealRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new DealNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await events.emit(
      createEvent({
        event: CrmEvents.DealDeleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "deal",
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "deal",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(ctx: DealsServiceContext, id: string): Promise<DealRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new DealNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.DealUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "deal",
        entityId: id,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "deal",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  return { list, get, create, update, changeStage, markWon, markLost, softDelete, restore }
}

export type DealsService = ReturnType<typeof createDealsService>
