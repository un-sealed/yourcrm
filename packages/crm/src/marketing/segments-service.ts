import { requirePermission } from "@yourcrm/permissions"
import {
  createMarketingSegmentSchema,
  marketingSegmentQuerySchema,
  updateMarketingSegmentSchema,
} from "./schemas"
import type {
  MarketingSegmentListResult,
  MarketingSegmentRecord,
  MarketingSegmentsServiceContext,
  MarketingSegmentsServiceDeps,
} from "./types"

export class MarketingSegmentNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`marketing segment ${id} not found`)
    this.name = "MarketingSegmentNotFoundError"
  }
}

function permissionOf(
  ctx: MarketingSegmentsServiceContext,
  action: "read" | "create" | "update" | "delete",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "marketing_segment",
    action,
  }
}

/**
 * Marketing segments domain service (spec 24-marketing, P0). A segment is a
 * NAMED FILTER TREE over people — the exact `@yourcrm/ui` FilterBuilder
 * encoding, reused (not reinvented) via `reports`'s `person` object at the
 * repository layer.
 *
 * EVENTS BLOCKER: `@yourcrm/events` has no marketing/campaign/segment event
 * group (`CrmEvents`, `CommunicationEvents`, ... — grep confirms none). Per
 * the hard rule "no string literals", this service does NOT fabricate one;
 * mutations are still audited via the injected `AuditWriter`. Adding
 * `MarketingEvents` (`segment.updated`, `campaign.scheduled`,
 * `campaign.sent`, `campaign.unsubscribed` per spec 24 section 9) to
 * `packages/events/src/envelope.ts` is a blocker for whoever owns that
 * package — see the module PR notes.
 */
export function createMarketingSegmentsService(deps: MarketingSegmentsServiceDeps) {
  async function list(
    ctx: MarketingSegmentsServiceContext,
    rawQuery: unknown,
  ): Promise<MarketingSegmentListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = marketingSegmentQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(
    ctx: MarketingSegmentsServiceContext,
    id: string,
  ): Promise<MarketingSegmentRecord> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findById(ctx.workspaceId, id)
    if (!found) throw new MarketingSegmentNotFoundError(id)
    return found
  }

  async function create(
    ctx: MarketingSegmentsServiceContext,
    rawInput: unknown,
  ): Promise<MarketingSegmentRecord> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createMarketingSegmentSchema.parse(rawInput)
    const segment = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "marketing_segment",
      recordId: segment.id,
      after: segment,
      correlationId: ctx.correlationId,
    })
    return segment
  }

  async function update(
    ctx: MarketingSegmentsServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<MarketingSegmentRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateMarketingSegmentSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new MarketingSegmentNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new MarketingSegmentNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "marketing_segment",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(
    ctx: MarketingSegmentsServiceContext,
    id: string,
  ): Promise<MarketingSegmentRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new MarketingSegmentNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "marketing_segment",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(
    ctx: MarketingSegmentsServiceContext,
    id: string,
  ): Promise<MarketingSegmentRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new MarketingSegmentNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "marketing_segment",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /** Live preview count — read-only, no audit row (not a mutation). */
  async function preview(
    ctx: MarketingSegmentsServiceContext,
    id: string,
  ): Promise<{ count: number }> {
    requirePermission(permissionOf(ctx, "read"))
    const segment = await deps.store.findById(ctx.workspaceId, id)
    if (!segment) throw new MarketingSegmentNotFoundError(id)
    const result = await deps.store.evaluate(ctx.workspaceId, segment.filter)
    await deps.store.recordEvaluation(ctx.workspaceId, id, result.count)
    return result
  }

  return { list, get, create, update, softDelete, restore, preview }
}

export type MarketingSegmentsService = ReturnType<typeof createMarketingSegmentsService>
