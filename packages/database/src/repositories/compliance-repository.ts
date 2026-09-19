import { and, desc, eq, gte, ilike, isNull, lte, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import { auditEvents } from "../schema/system"
import { dataRequests } from "../schema/settings"
import {
  clampSettingsLimit,
  decodeSettingsCursor,
  paginateSettingsRows,
  settingsKeysetCondition,
  type SettingsListOptions,
  type SettingsPage,
} from "./settings-repository"

/**
 * Compliance persistence (spec 40, P0): the audit-log reader and the
 * GDPR/DPDP data-request store.
 *
 * APPEND-ONLY, STRUCTURALLY
 * -------------------------
 * `createAuditLogReader()` exposes `list` and `findById` and nothing else.
 * There is no update, no delete, no soft-delete and no restore anywhere on
 * the audit path — not "we chose not to call one", but *no such function
 * exists to call*, so no route, service or future refactor can reach one.
 * `0320_settings.sql` backs that up with a trigger that rejects UPDATE,
 * DELETE and TRUNCATE on `audit_events` at the storage layer.
 *
 * `writeAudit()` in `../audit.ts` remains the only writer, and it only
 * inserts.
 */

export type AuditEventReadRow = {
  id: string
  workspaceId: string
  actorId: string | null
  action: string
  object: string
  recordId: string | null
  before: unknown
  after: unknown
  correlationId: string | null
  source: string
  createdAt: string
}

export type AuditLogFilter = SettingsListOptions & {
  /** Substring match on the action name. */
  action?: string
  object?: string
  actorId?: string
  recordId?: string
  source?: string
  /** ISO timestamps, inclusive. */
  from?: string
  to?: string
  /** Free-text over action + object. */
  query?: string
}

function isoRequired(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : isoRequired(value)
}

function toAuditRow(row: {
  id: string
  workspaceId: string
  actorId: string | null
  action: string
  object: string
  recordId: string | null
  before: unknown
  after: unknown
  correlationId: string | null
  source: string
  createdAt: Date | string
}): AuditEventReadRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    actorId: row.actorId,
    action: row.action,
    object: row.object,
    recordId: row.recordId,
    before: row.before,
    after: row.after,
    correlationId: row.correlationId,
    source: row.source,
    createdAt: isoRequired(row.createdAt),
  }
}

/**
 * READ-ONLY view over `audit_events`. Two methods, both SELECTs — see the
 * file header for why that is the whole point of this object.
 */
export function createAuditLogReader() {
  return {
    async list(
      db: Database,
      workspaceId: string,
      opts: AuditLogFilter = {},
    ): Promise<SettingsPage<AuditEventReadRow>> {
      const limit = clampSettingsLimit(opts.limit)
      const conditions: SQL[] = [eq(auditEvents.workspaceId, workspaceId)]
      if (opts.action) conditions.push(eq(auditEvents.action, opts.action))
      if (opts.object) conditions.push(eq(auditEvents.object, opts.object))
      if (opts.actorId) conditions.push(eq(auditEvents.actorId, opts.actorId))
      if (opts.recordId) conditions.push(eq(auditEvents.recordId, opts.recordId))
      if (opts.source) conditions.push(eq(auditEvents.source, opts.source))
      if (opts.from) conditions.push(gte(auditEvents.createdAt, new Date(opts.from)))
      if (opts.to) conditions.push(lte(auditEvents.createdAt, new Date(opts.to)))
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const match = or(ilike(auditEvents.action, q), ilike(auditEvents.object, q))
        if (match) conditions.push(match)
      }
      const cursor = decodeSettingsCursor(opts.cursor)
      if (cursor) {
        conditions.push(settingsKeysetCondition(auditEvents.createdAt, auditEvents.id, cursor))
      }
      const rows = await db
        .select()
        .from(auditEvents)
        .where(and(...conditions))
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(limit + 1)
      return paginateSettingsRows(rows.map(toAuditRow), limit)
    },

    async findById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<AuditEventReadRow | null> {
      const rows = await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.id, id), eq(auditEvents.workspaceId, workspaceId)))
        .limit(1)
      const row = rows[0]
      return row ? toAuditRow(row) : null
    },
  }
}

export type AuditLogReader = ReturnType<typeof createAuditLogReader>

export type DataRequestReadRow = {
  id: string
  workspaceId: string
  kind: string
  subjectType: string
  subjectId: string
  status: string
  reason: string | null
  requestedBy: string | null
  completedAt: string | null
  completedBy: string | null
  createdAt: string
}

export type CreateDataRequestInput = {
  kind: string
  subjectType: string
  subjectId: string
  reason?: string | null
  status?: string
}

function toDataRequestRow(row: {
  id: string
  workspaceId: string
  kind: string
  subjectType: string
  subjectId: string
  status: string
  reason: string | null
  requestedBy: string | null
  completedAt: Date | string | null
  completedBy: string | null
  createdAt: Date | string
}): DataRequestReadRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    status: row.status,
    reason: row.reason,
    requestedBy: row.requestedBy,
    completedAt: iso(row.completedAt),
    completedBy: row.completedBy,
    createdAt: isoRequired(row.createdAt),
  }
}

/**
 * GDPR/DPDP requests. The row is a *record of the request*: it never stores
 * the subject's data, so fulfilling an export does not create a second copy
 * of the personal data the request is about.
 */
export function createDataRequestRepository() {
  return {
    async list(
      db: Database,
      workspaceId: string,
      opts: SettingsListOptions & { kind?: string; status?: string; subjectId?: string } = {},
    ): Promise<SettingsPage<DataRequestReadRow>> {
      const limit = clampSettingsLimit(opts.limit)
      const conditions: SQL[] = [
        eq(dataRequests.workspaceId, workspaceId),
        isNull(dataRequests.deletedAt),
      ]
      if (opts.kind) conditions.push(eq(dataRequests.kind, opts.kind))
      if (opts.status) conditions.push(eq(dataRequests.status, opts.status))
      if (opts.subjectId) conditions.push(eq(dataRequests.subjectId, opts.subjectId))
      const cursor = decodeSettingsCursor(opts.cursor)
      if (cursor) {
        conditions.push(settingsKeysetCondition(dataRequests.createdAt, dataRequests.id, cursor))
      }
      const rows = await db
        .select()
        .from(dataRequests)
        .where(and(...conditions))
        .orderBy(desc(dataRequests.createdAt), desc(dataRequests.id))
        .limit(limit + 1)
      return paginateSettingsRows(rows.map(toDataRequestRow), limit)
    },

    async findById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<DataRequestReadRow | null> {
      const rows = await db
        .select()
        .from(dataRequests)
        .where(
          and(
            eq(dataRequests.id, id),
            eq(dataRequests.workspaceId, workspaceId),
            isNull(dataRequests.deletedAt),
          ),
        )
        .limit(1)
      const row = rows[0]
      return row ? toDataRequestRow(row) : null
    },

    async create(
      db: Database,
      workspaceId: string,
      input: CreateDataRequestInput,
      actorId?: string,
    ): Promise<DataRequestReadRow> {
      const rows = await db
        .insert(dataRequests)
        .values({
          workspaceId,
          kind: input.kind,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          reason: input.reason ?? null,
          status: input.status ?? "pending",
          requestedBy: actorId ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("dataRequests.create: insert returned no rows")
      return toDataRequestRow(row)
    },

    /**
     * Move a request to a terminal status. There is no hard delete here on
     * purpose: P0 soft-deletes the subject and records that it happened; the
     * purge itself is a retention policy that has not been specified yet.
     */
    async markStatus(
      db: Database,
      workspaceId: string,
      id: string,
      status: string,
      actorId?: string,
    ): Promise<DataRequestReadRow | null> {
      const now = new Date()
      const rows = await db
        .update(dataRequests)
        .set({
          status,
          completedAt: now,
          completedBy: actorId ?? null,
          updatedAt: now,
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(
          and(
            eq(dataRequests.id, id),
            eq(dataRequests.workspaceId, workspaceId),
            isNull(dataRequests.deletedAt),
          ),
        )
        .returning()
      const row = rows[0]
      return row ? toDataRequestRow(row) : null
    },
  }
}

export type DataRequestRepository = ReturnType<typeof createDataRequestRepository>
