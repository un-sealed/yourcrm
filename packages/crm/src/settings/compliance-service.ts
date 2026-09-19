import { requirePermission } from "@yourcrm/permissions"
import {
  dataRequestCreateSchema,
  dataRequestQuerySchema,
  workspaceAuditQuerySchema,
} from "./schemas"
import type {
  ComplianceServiceDeps,
  DataRequestRecord,
  SettingsPage,
  SettingsServiceContext,
  WorkspaceAuditRecord,
} from "./types"

/**
 * Compliance service (spec 40, P0): the audit-log viewer and GDPR/DPDP
 * export + deletion requests.
 *
 * AUDIT IS READ-ONLY HERE, BY CONSTRUCTION
 * ----------------------------------------
 * This service can list and read audit rows. It cannot edit or delete one,
 * because `deps.auditLog` (`WorkspaceAuditLogPort`) has no such method to
 * call, the repository behind it (`createAuditLogReader`) defines none, and
 * `0320_settings.sql` installs a trigger that rejects UPDATE/DELETE/TRUNCATE
 * on `audit_events` at the storage layer. Three independent layers, so
 * "someone adds a fixup endpoint later" fails at compile time, at review
 * time and at run time.
 *
 * Reading the audit log is itself an administrative action, so it is gated
 * on `admin` like every other method here — an audit trail that every viewer
 * can read is an information leak about records they cannot see.
 *
 * EXPORTS CARRY NO SECOND COPY
 * ----------------------------
 * A request row records *that* an export was asked for. The data itself is
 * assembled live from the owning module (`deps.subjects`) at download time
 * and is never written into `data_requests` — answering a privacy request
 * must not create another place the subject's data lives. The audit rows
 * this service writes hold ids and status only, never subject fields.
 *
 * DELETION IS A SOFT DELETE
 * -------------------------
 * `requestDeletion` soft-deletes the subject through the owning module's
 * repository and records the request as `soft_deleted`. The irreversible
 * purge is a retention policy that has not been specified (spec 40 §3, P1);
 * doing it now would destroy data with no policy, no approval step and no
 * way back.
 */

export class DataRequestNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`data request ${id} not found`)
    this.name = "DataRequestNotFoundError"
  }
}

export class DataSubjectNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(subjectId: string) {
    super(`data subject ${subjectId} not found in this workspace`)
    this.name = "DataSubjectNotFoundError"
  }
}

export class DataRequestKindError extends Error {
  readonly code = "VALIDATION_ERROR"
  constructor(message: string) {
    super(message)
    this.name = "DataRequestKindError"
  }
}

export type DataSubjectExport = {
  requestId: string
  subjectType: string
  subjectId: string
  generatedAt: string
  record: Record<string, unknown>
}

function permissionOf(ctx: SettingsServiceContext, object: string) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object,
    action: "admin" as const,
  }
}

export function createComplianceService(deps: ComplianceServiceDeps) {
  /** Filterable, cursor-paginated audit log. Read-only — see file header. */
  async function listAuditEvents(
    ctx: SettingsServiceContext,
    rawQuery: unknown,
  ): Promise<SettingsPage<WorkspaceAuditRecord>> {
    requirePermission(permissionOf(ctx, "audit_event"))
    const query = workspaceAuditQuerySchema.parse(rawQuery)
    return deps.auditLog.list(ctx.workspaceId, query)
  }

  async function getAuditEvent(
    ctx: SettingsServiceContext,
    id: string,
  ): Promise<WorkspaceAuditRecord | null> {
    requirePermission(permissionOf(ctx, "audit_event"))
    return deps.auditLog.findById(ctx.workspaceId, id)
  }

  async function listDataRequests(
    ctx: SettingsServiceContext,
    rawQuery: unknown,
  ): Promise<SettingsPage<DataRequestRecord>> {
    requirePermission(permissionOf(ctx, "data_request"))
    const query = dataRequestQuerySchema.parse(rawQuery)
    return deps.requests.list(ctx.workspaceId, query)
  }

  /**
   * Record an export or deletion request. A deletion additionally
   * soft-deletes the subject through the owning module's contract, so the
   * record stops being visible the moment the request is accepted.
   */
  async function createDataRequest(
    ctx: SettingsServiceContext,
    rawInput: unknown,
  ): Promise<DataRequestRecord> {
    requirePermission(permissionOf(ctx, "data_request"))
    const input = dataRequestCreateSchema.parse(rawInput)
    const subject = await deps.subjects.load(ctx.workspaceId, input.subjectId)
    if (!subject) throw new DataSubjectNotFoundError(input.subjectId)

    const created = await deps.requests.create(
      ctx.workspaceId,
      {
        kind: input.kind,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        reason: input.reason ?? null,
        status: "pending",
      },
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: input.kind === "export" ? "data_request.export" : "data_request.deletion",
      object: "data_request",
      recordId: created.id,
      // Ids and status only: no subject fields in the audit trail.
      after: { kind: created.kind, subjectType: created.subjectType, subjectId: created.subjectId },
      correlationId: ctx.correlationId,
    })

    if (input.kind !== "deletion") return created

    const erased = await deps.subjects.softDelete(ctx.workspaceId, input.subjectId, ctx.actorId)
    if (!erased) throw new DataSubjectNotFoundError(input.subjectId)
    const completed = await deps.requests.markStatus(
      ctx.workspaceId,
      created.id,
      "soft_deleted",
      ctx.actorId,
    )
    if (!completed) throw new DataRequestNotFoundError(created.id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "data_request.soft_deleted",
      object: "data_request",
      recordId: created.id,
      before: { status: created.status },
      after: { status: completed.status, subjectId: completed.subjectId },
      correlationId: ctx.correlationId,
    })
    return completed
  }

  /**
   * Assemble the export for a pending export request. The subject data is
   * read live and returned; it is never stored on the request row.
   */
  async function fulfilExportRequest(
    ctx: SettingsServiceContext,
    id: string,
  ): Promise<DataSubjectExport> {
    requirePermission(permissionOf(ctx, "data_request"))
    const request = await deps.requests.findById(ctx.workspaceId, id)
    if (!request) throw new DataRequestNotFoundError(id)
    if (request.kind !== "export") {
      throw new DataRequestKindError(`data request ${id} is a ${request.kind}, not an export`)
    }
    const record = await deps.subjects.load(ctx.workspaceId, request.subjectId)
    if (!record) throw new DataSubjectNotFoundError(request.subjectId)
    const fulfilled = await deps.requests.markStatus(ctx.workspaceId, id, "fulfilled", ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "data_request.fulfilled",
      object: "data_request",
      recordId: id,
      before: { status: request.status },
      after: { status: fulfilled?.status ?? "fulfilled", subjectId: request.subjectId },
      correlationId: ctx.correlationId,
    })
    return {
      requestId: id,
      subjectType: request.subjectType,
      subjectId: request.subjectId,
      generatedAt: new Date().toISOString(),
      record,
    }
  }

  return {
    listAuditEvents,
    getAuditEvent,
    listDataRequests,
    createDataRequest,
    fulfilExportRequest,
  }
}

export type ComplianceService = ReturnType<typeof createComplianceService>
