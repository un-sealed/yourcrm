import { CrmEvents, createEvent, getEventBus } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import { createCompanySchema, companyQuerySchema, updateCompanySchema } from "./schemas"
import type {
  CompaniesServiceContext,
  CompaniesServiceDeps,
  CompanyListResult,
  CompanyRecord,
  CompanyWithAddresses,
} from "./types"

export class CompanyNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`company ${id} not found`)
    this.name = "CompanyNotFoundError"
  }
}

function permissionOf(
  ctx: CompaniesServiceContext,
  action: "read" | "create" | "update" | "delete",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "company",
    action,
  }
}

/**
 * Companies domain service (mirrors the people module pattern).
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. does the work through the injected `CompaniesStore` port;
 *  3. emits the domain event via the `CrmEvents` constant (never a literal);
 *  4. writes the audit row with before/after (mutations only).
 */
export function createCompaniesService(deps: CompaniesServiceDeps) {
  const events = deps.events ?? getEventBus()

  async function list(ctx: CompaniesServiceContext, rawQuery: unknown): Promise<CompanyListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = companyQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(ctx: CompaniesServiceContext, id: string): Promise<CompanyWithAddresses> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findWithAddresses(ctx.workspaceId, id)
    if (!found) throw new CompanyNotFoundError(id)
    const children = await deps.store.listChildren(ctx.workspaceId, id)
    return { company: found.company, addresses: found.addresses, children }
  }

  async function create(ctx: CompaniesServiceContext, rawInput: unknown): Promise<CompanyRecord> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createCompanySchema.parse(rawInput)
    const company = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await events.emit(
      createEvent({
        event: CrmEvents.CompanyCreated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "company",
        entityId: company.id,
        after: company,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "company",
      recordId: company.id,
      after: company,
      correlationId: ctx.correlationId,
    })
    return company
  }

  async function update(
    ctx: CompaniesServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<CompanyRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateCompanySchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new CompanyNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new CompanyNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.CompanyUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "company",
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
      object: "company",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(ctx: CompaniesServiceContext, id: string): Promise<CompanyRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new CompanyNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await events.emit(
      createEvent({
        event: CrmEvents.CompanyDeleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "company",
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "company",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(ctx: CompaniesServiceContext, id: string): Promise<CompanyRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new CompanyNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.CompanyUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "company",
        entityId: id,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "company",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  return { list, get, create, update, softDelete, restore }
}

export type CompaniesService = ReturnType<typeof createCompaniesService>
