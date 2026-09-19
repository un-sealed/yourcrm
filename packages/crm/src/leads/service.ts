import { CrmEvents, createEvent, getEventBus } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import { convertLeadSchema, createLeadSchema, leadQuerySchema, updateLeadSchema } from "./types"
import type { LeadListResult, LeadRecord, LeadsServiceContext, LeadsServiceDeps } from "./types"

export class LeadNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`lead ${id} not found`)
    this.name = "LeadNotFoundError"
  }
}

function permissionOf(ctx: LeadsServiceContext, action: "read" | "create" | "update" | "delete") {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "lead",
    action,
  }
}

/**
 * Leads domain service (mirrors the people golden reference).
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. does the work through the injected `LeadsStore` port;
 *  3. emits the domain event via the `CrmEvents` constant (never a literal);
 *  4. writes the audit row with before/after (mutations only).
 */
export function createLeadsService(deps: LeadsServiceDeps) {
  const events = deps.events ?? getEventBus()

  async function list(ctx: LeadsServiceContext, rawQuery: unknown): Promise<LeadListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = leadQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(ctx: LeadsServiceContext, id: string): Promise<LeadRecord> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findById(ctx.workspaceId, id)
    if (!found) throw new LeadNotFoundError(id)
    return found
  }

  async function create(ctx: LeadsServiceContext, rawInput: unknown): Promise<LeadRecord> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createLeadSchema.parse(rawInput)
    const lead = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await events.emit(
      createEvent({
        event: CrmEvents.LeadCreated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "lead",
        entityId: lead.id,
        after: lead,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "lead",
      recordId: lead.id,
      after: lead,
      correlationId: ctx.correlationId,
    })
    return lead
  }

  async function update(
    ctx: LeadsServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<LeadRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateLeadSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new LeadNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new LeadNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.LeadUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "lead",
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
      object: "lead",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Move a lead to `qualified`. Emits `lead.qualified` (the lifecycle step
   * the list/detail UIs and future automations key on).
   */
  async function qualify(ctx: LeadsServiceContext, id: string): Promise<LeadRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new LeadNotFoundError(id)
    const after = await deps.store.update(ctx.workspaceId, id, { status: "qualified" }, ctx.actorId)
    if (!after) throw new LeadNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.LeadQualified,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "lead",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "qualify",
      object: "lead",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Convert a lead: store the target ids and flip status to `converted`,
   * then emit `lead.converted` with the targets. The actual
   * Person/Company/Deal wiring is a later integration pass.
   */
  async function convert(
    ctx: LeadsServiceContext,
    id: string,
    rawTargets: unknown,
  ): Promise<LeadRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const targets = convertLeadSchema.parse(rawTargets ?? {})
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new LeadNotFoundError(id)
    const patch: Record<string, unknown> = { status: "converted" }
    if (targets.personId !== undefined) patch.personId = targets.personId
    if (targets.companyId !== undefined) patch.companyId = targets.companyId
    if (targets.dealId !== undefined) patch.dealId = targets.dealId
    const after = await deps.store.update(ctx.workspaceId, id, patch, ctx.actorId)
    if (!after) throw new LeadNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.LeadConverted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "lead",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "convert",
      object: "lead",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(ctx: LeadsServiceContext, id: string): Promise<LeadRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new LeadNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await events.emit(
      createEvent({
        event: CrmEvents.LeadDeleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "lead",
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "lead",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(ctx: LeadsServiceContext, id: string): Promise<LeadRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new LeadNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.LeadUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "lead",
        entityId: id,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "lead",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  return { list, get, create, update, qualify, convert, softDelete, restore }
}

export type LeadsService = ReturnType<typeof createLeadsService>
