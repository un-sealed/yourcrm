import { requirePermission } from "@yourcrm/permissions"
import {
  createMarketingCampaignSchema,
  marketingCampaignQuerySchema,
  scheduleMarketingCampaignSchema,
  updateMarketingCampaignSchema,
} from "./schemas"
import type {
  MarketingCampaignListResult,
  MarketingCampaignRecord,
  MarketingCampaignsServiceContext,
  MarketingCampaignsServiceDeps,
} from "./types"

export class MarketingCampaignNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`campaign ${id} not found`)
    this.name = "MarketingCampaignNotFoundError"
  }
}

export class MarketingSegmentNotFoundForCampaignError extends Error {
  readonly code = "NOT_FOUND"
  constructor(segmentId: string) {
    super(`segment ${segmentId} not found`)
    this.name = "MarketingSegmentNotFoundForCampaignError"
  }
}

export class MarketingCampaignStateError extends Error {
  readonly code = "INVALID_STATE"
  constructor(message: string) {
    super(message)
    this.name = "MarketingCampaignStateError"
  }
}

const DEFAULT_BATCH_SIZE = 50

function permissionOf(
  ctx: MarketingCampaignsServiceContext,
  action: "read" | "create" | "update" | "delete" | "send_external",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "campaign",
    action,
  }
}

/**
 * Campaigns domain service (spec 24-marketing, P0), mirroring the `people`
 * reference module. Sending is orchestrated here but never executed here:
 * `send()` materialises the consent-filtered recipient list in one SQL
 * statement (`recipients.prepareRecipients` — see the repository for why
 * an unsubscribed/non-consented person can never appear in it) and hands
 * the first BATCH off through the injected `MarketingQueuePort`. The
 * per-recipient email send happens in `apps/worker/src/jobs/campaigns.ts`
 * via `batch-service.ts`'s `sendBatch`, never inline in this request.
 *
 * EVENTS BLOCKER: see `segments-service.ts` — no `MarketingEvents` group
 * exists in `@yourcrm/events` yet, so mutations here are audited but do not
 * emit domain events (no string literals per the hard rule).
 */
export function createMarketingCampaignsService(deps: MarketingCampaignsServiceDeps) {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE

  async function list(
    ctx: MarketingCampaignsServiceContext,
    rawQuery: unknown,
  ): Promise<MarketingCampaignListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = marketingCampaignQuerySchema.parse(rawQuery)
    return deps.campaigns.list(ctx.workspaceId, query)
  }

  async function get(
    ctx: MarketingCampaignsServiceContext,
    id: string,
  ): Promise<MarketingCampaignRecord> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.campaigns.findById(ctx.workspaceId, id)
    if (!found) throw new MarketingCampaignNotFoundError(id)
    return found
  }

  async function create(
    ctx: MarketingCampaignsServiceContext,
    rawInput: unknown,
  ): Promise<MarketingCampaignRecord> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createMarketingCampaignSchema.parse(rawInput)
    const segment = await deps.segments.findById(ctx.workspaceId, input.segmentId)
    if (!segment) throw new MarketingSegmentNotFoundForCampaignError(input.segmentId)
    const campaign = await deps.campaigns.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "campaign",
      recordId: campaign.id,
      after: campaign,
      correlationId: ctx.correlationId,
    })
    return campaign
  }

  async function update(
    ctx: MarketingCampaignsServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<MarketingCampaignRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateMarketingCampaignSchema.parse(rawPatch)
    const before = await deps.campaigns.findById(ctx.workspaceId, id)
    if (!before) throw new MarketingCampaignNotFoundError(id)
    if (before.status !== "draft") {
      throw new MarketingCampaignStateError(
        `campaign ${id} is '${String(before.status)}': only a draft can be edited`,
      )
    }
    if (patch.segmentId) {
      const segment = await deps.segments.findById(ctx.workspaceId, patch.segmentId)
      if (!segment) throw new MarketingSegmentNotFoundForCampaignError(patch.segmentId)
    }
    const after = await deps.campaigns.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new MarketingCampaignNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "campaign",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(
    ctx: MarketingCampaignsServiceContext,
    id: string,
  ): Promise<MarketingCampaignRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.campaigns.findById(ctx.workspaceId, id)
    if (!before) throw new MarketingCampaignNotFoundError(id)
    await deps.campaigns.softDelete(ctx.workspaceId, id, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "campaign",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  /** Persist an intended send time. Actually triggering it is a scheduler concern (P1). */
  async function schedule(
    ctx: MarketingCampaignsServiceContext,
    id: string,
    rawInput: unknown,
  ): Promise<MarketingCampaignRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const input = scheduleMarketingCampaignSchema.parse(rawInput)
    const before = await deps.campaigns.findById(ctx.workspaceId, id)
    if (!before) throw new MarketingCampaignNotFoundError(id)
    if (before.status !== "draft" && before.status !== "scheduled") {
      throw new MarketingCampaignStateError(
        `campaign ${id} is '${String(before.status)}': cannot schedule`,
      )
    }
    const after = await deps.campaigns.setStatus(ctx.workspaceId, id, "scheduled", {
      scheduledAt: input.scheduledAt,
    })
    if (!after) throw new MarketingCampaignNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "schedule",
      object: "campaign",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Trigger a send. `send_external` gate (spec: viewers/members below the
   * threshold are denied — see `service.test.ts`). Materialises the
   * consent-filtered recipient list, flips the campaign to `sending`, and
   * enqueues the FIRST batch; the worker claims and sends batches (and
   * self-enqueues the next one) until no `pending` rows remain.
   */
  async function send(
    ctx: MarketingCampaignsServiceContext,
    id: string,
  ): Promise<MarketingCampaignRecord> {
    requirePermission(permissionOf(ctx, "send_external"))
    const before = await deps.campaigns.findById(ctx.workspaceId, id)
    if (!before) throw new MarketingCampaignNotFoundError(id)
    if (before.status !== "draft" && before.status !== "scheduled") {
      throw new MarketingCampaignStateError(
        `campaign ${id} is '${String(before.status)}': cannot send`,
      )
    }
    const segment = await deps.segments.findById(ctx.workspaceId, before.segmentId)
    if (!segment) throw new MarketingSegmentNotFoundForCampaignError(before.segmentId)

    await deps.recipients.prepareRecipients({
      workspaceId: ctx.workspaceId,
      campaignId: id,
      segmentFilter: segment.filter,
    })
    const counts = await deps.recipients.countsByStatus(ctx.workspaceId, id)
    const recipientCount = Object.values(counts).reduce((sum, n) => sum + n, 0)
    await deps.campaigns.setCounters(ctx.workspaceId, id, { recipientCount })

    const after = await deps.campaigns.setStatus(ctx.workspaceId, id, "sending")
    if (!after) throw new MarketingCampaignNotFoundError(id)

    await deps.queue.enqueueCampaignBatch({
      workspaceId: ctx.workspaceId,
      campaignId: id,
      batchSize,
      correlationId: ctx.correlationId,
    })

    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "send",
      object: "campaign",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function cancel(
    ctx: MarketingCampaignsServiceContext,
    id: string,
  ): Promise<MarketingCampaignRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const before = await deps.campaigns.findById(ctx.workspaceId, id)
    if (!before) throw new MarketingCampaignNotFoundError(id)
    if (before.status !== "draft" && before.status !== "scheduled") {
      throw new MarketingCampaignStateError(
        `campaign ${id} is '${String(before.status)}': cannot cancel`,
      )
    }
    const after = await deps.campaigns.setStatus(ctx.workspaceId, id, "cancelled")
    if (!after) throw new MarketingCampaignNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "cancel",
      object: "campaign",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  return { list, get, create, update, softDelete, schedule, send, cancel }
}

export type MarketingCampaignsService = ReturnType<typeof createMarketingCampaignsService>
