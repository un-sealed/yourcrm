import { and, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  callRecordings,
  calls,
  isCallDirection,
  isCallSource,
  isCallStatus,
  type CallRecordingRow,
  type CallRow,
  type NewCallRow,
} from "../schema/calling"
import { createBaseRepository } from "./base-repository"

/**
 * E.164 phone normalisation, applied on every write.
 *
 * This is a deliberate, minimal duplicate of
 * `packages/crm/src/calling/phone.ts` (repositories cannot import
 * `@yourcrm/crm` — see that file's header and `people-repository.ts`'s own
 * local `validatePersonEmail`/`validatePersonPhone` for the same pattern).
 * Unlike the crm-layer helper, this one has no "default calling code"
 * fallback: at persistence time a number must already carry an
 * international prefix (`+` or `00`), so the stored value is unambiguous.
 */
export class InvalidCallPhoneNumberError extends Error {
  readonly code = "INVALID_PHONE_NUMBER"
  constructor(raw: string) {
    super(`"${raw}" is not a normalisable phone number (expected E.164, e.g. +14155550123)`)
    this.name = "InvalidCallPhoneNumberError"
  }
}

const MIN_PHONE_DIGITS = 8
const MAX_PHONE_DIGITS = 15

export function normalizeCallPhoneE164(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new InvalidCallPhoneNumberError(raw)
  const hasPlus = trimmed.startsWith("+")
  const digitsOnly = trimmed.replace(/[^\d]/g, "")
  if (digitsOnly.length === 0) throw new InvalidCallPhoneNumberError(raw)
  let national: string
  if (hasPlus) national = digitsOnly
  else if (digitsOnly.startsWith("00")) national = digitsOnly.slice(2)
  else throw new InvalidCallPhoneNumberError(raw)
  if (national.length < MIN_PHONE_DIGITS || national.length > MAX_PHONE_DIGITS) {
    throw new InvalidCallPhoneNumberError(raw)
  }
  return `+${national}`
}

/**
 * Status-rank guard, mirroring `packages/crm/src/calling/status.ts`
 * (duplicated on purpose — repositories cannot import `@yourcrm/crm`). The
 * crm package owns the tested business rule; this SQL fragment is a
 * defense-in-depth backstop so a race between two concurrent webhook
 * deliveries cannot regress a call even if the service-layer check is
 * bypassed.
 */
const STATUS_RANK_SQL = sql`(CASE ${calls.status}
  WHEN 'completed' THEN 3 WHEN 'failed' THEN 3 WHEN 'no_answer' THEN 3 WHEN 'busy' THEN 3
  WHEN 'in_progress' THEN 2 WHEN 'ringing' THEN 1 ELSE 0 END)`

const TERMINAL_STATUSES_SQL = sql`${calls.status} IN ('completed', 'failed', 'no_answer', 'busy')`

function rankOf(status: string): number {
  switch (status) {
    case "completed":
    case "failed":
    case "no_answer":
    case "busy":
      return 3
    case "in_progress":
      return 2
    case "ringing":
      return 1
    default:
      return 0
  }
}

export type CreateCallInput = {
  direction: string
  status?: string
  source?: string
  fromNumber: string
  toNumber: string
  personId?: string | null
  companyId?: string | null
  dealId?: string | null
  ownerId?: string | null
  connectionId?: string | null
  providerId?: string | null
  providerCallId?: string | null
  startedAt?: Date | null
  endedAt?: Date | null
  durationSeconds?: number | null
  disposition?: string | null
  notes?: string | null
  recordingConsent?: boolean
  errorMessage?: string | null
}

export type UpdateCallInput = {
  personId?: string | null
  companyId?: string | null
  dealId?: string | null
  ownerId?: string | null
  disposition?: string | null
  notes?: string | null
  recordingConsent?: boolean
  providerCallId?: string | null
}

export type AdvanceCallStatusInput = {
  status: string
  occurredAt: Date
  startedAt?: Date | null
  endedAt?: Date | null
  durationSeconds?: number | null
  errorMessage?: string | null
}

export type CallSearchOptions = {
  workspaceId: string
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  direction?: string
  status?: string
  personId?: string
  companyId?: string
  dealId?: string
  ownerId?: string
  query?: string
}

function assertDirection(value: string): string {
  if (!isCallDirection(value)) throw new Error("calls: direction must be one of inbound, outbound")
  return value
}

function assertStatus(value: string): string {
  if (!isCallStatus(value)) {
    throw new Error(
      "calls: status must be one of queued, ringing, in_progress, completed, failed, no_answer, busy",
    )
  }
  return value
}

function assertSource(value: string): string {
  if (!isCallSource(value)) throw new Error("calls: source must be one of manual, provider")
  return value
}

function toCreateValues(workspaceId: string, input: CreateCallInput, actorId?: string): NewCallRow {
  return {
    workspaceId,
    direction: assertDirection(input.direction),
    status: assertStatus(input.status ?? "queued"),
    source: assertSource(input.source ?? "manual"),
    fromNumber: normalizeCallPhoneE164(input.fromNumber),
    toNumber: normalizeCallPhoneE164(input.toNumber),
    personId: input.personId ?? null,
    companyId: input.companyId ?? null,
    dealId: input.dealId ?? null,
    ownerId: input.ownerId ?? null,
    connectionId: input.connectionId ?? null,
    providerId: input.providerId ?? null,
    providerCallId: input.providerCallId ?? null,
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null,
    durationSeconds: input.durationSeconds ?? null,
    disposition: input.disposition?.trim() || null,
    notes: input.notes ?? null,
    // Explicit, never defaults to true.
    recordingConsent: input.recordingConsent ?? false,
    errorMessage: input.errorMessage ?? null,
    ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
  }
}

/**
 * Workspace-scoped calls + recording metadata. `person_id`/`company_id`/
 * `deal_id`/`connection_id` stay plain columns (no join here) — those
 * tables belong to other modules.
 */
export function createCallingRepository() {
  const base = createBaseRepository(calls)

  return {
    ...base,

    async create(db: Database, workspaceId: string, input: CreateCallInput, actorId?: string) {
      const rows = await db
        .insert(calls)
        .values(toCreateValues(workspaceId, input, actorId))
        .returning()
      const row = rows[0]
      if (!row) throw new Error("calls.create: insert returned no rows")
      return row
    },

    /** Cursor-paginated list with structured filters + free-text search. */
    async search(db: Database, opts: CallSearchOptions) {
      const conditions: SQL[] = []
      if (opts.direction) conditions.push(eq(calls.direction, assertDirection(opts.direction)))
      if (opts.status) conditions.push(eq(calls.status, assertStatus(opts.status)))
      if (opts.personId) conditions.push(eq(calls.personId, opts.personId))
      if (opts.companyId) conditions.push(eq(calls.companyId, opts.companyId))
      if (opts.dealId) conditions.push(eq(calls.dealId, opts.dealId))
      if (opts.ownerId) conditions.push(eq(calls.ownerId, opts.ownerId))
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const match = or(
          ilike(calls.fromNumber, q),
          ilike(calls.toNumber, q),
          ilike(calls.disposition, q),
          ilike(calls.notes, q),
        )
        if (match) conditions.push(match)
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as CallRow[], pagination: result.pagination }
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<CallRow | null> {
      const row = await base.findById(db, workspaceId, id)
      return (row as CallRow | null) ?? null
    },

    async findByProviderCallId(
      db: Database,
      workspaceId: string,
      providerId: string,
      providerCallId: string,
    ): Promise<CallRow | null> {
      const rows = await db
        .select()
        .from(calls)
        .where(
          and(
            eq(calls.workspaceId, workspaceId),
            eq(calls.providerId, providerId),
            eq(calls.providerCallId, providerCallId),
            isNull(calls.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateCallInput,
      actorId?: string,
    ): Promise<CallRow | null> {
      const values: Record<string, unknown> = { updatedAt: new Date() }
      if (input.personId !== undefined) values.personId = input.personId
      if (input.companyId !== undefined) values.companyId = input.companyId
      if (input.dealId !== undefined) values.dealId = input.dealId
      if (input.ownerId !== undefined) values.ownerId = input.ownerId
      if (input.disposition !== undefined) values.disposition = input.disposition?.trim() || null
      if (input.notes !== undefined) values.notes = input.notes
      if (input.recordingConsent !== undefined) values.recordingConsent = input.recordingConsent
      if (input.providerCallId !== undefined) values.providerCallId = input.providerCallId
      if (actorId !== undefined) values.updatedBy = actorId

      const rows = await db
        .update(calls)
        .set(values)
        .where(and(eq(calls.id, id), eq(calls.workspaceId, workspaceId), isNull(calls.deletedAt)))
        .returning()
      return rows[0] ?? null
    },

    /**
     * Guarded status transition (see `../../../crm/src/calling/status.ts`
     * for the tested decision table this mirrors). Returns `applied: false`
     * — never throws — when the incoming status is out-of-order, late or
     * the call is already terminal; callers must treat that as a no-op.
     */
    async advanceStatus(
      db: Database,
      workspaceId: string,
      id: string,
      next: AdvanceCallStatusInput,
    ): Promise<{ record: CallRow | null; applied: boolean }> {
      const status = assertStatus(next.status)
      const newRank = rankOf(status)
      const rows = await db
        .update(calls)
        .set({
          status,
          updatedAt: new Date(),
          ...(next.startedAt !== undefined ? { startedAt: next.startedAt } : {}),
          ...(next.endedAt !== undefined ? { endedAt: next.endedAt } : {}),
          ...(next.durationSeconds !== undefined ? { durationSeconds: next.durationSeconds } : {}),
          ...(next.errorMessage !== undefined ? { errorMessage: next.errorMessage } : {}),
        })
        .where(
          and(
            eq(calls.id, id),
            eq(calls.workspaceId, workspaceId),
            isNull(calls.deletedAt),
            sql`NOT (${TERMINAL_STATUSES_SQL})`,
            sql`${STATUS_RANK_SQL} <= ${newRank}`,
          ),
        )
        .returning()
      if (rows[0]) return { record: rows[0], applied: true }
      const current = await this.findById(db, workspaceId, id)
      return { record: current, applied: false }
    },

    async softDelete(
      db: Database,
      workspaceId: string,
      id: string,
      actorId?: string,
    ): Promise<void> {
      await base.softDelete(db, workspaceId, id, actorId)
    },

    async restore(db: Database, workspaceId: string, id: string): Promise<void> {
      await base.restore(db, workspaceId, id)
    },

    /* ------------------------------ recordings ---------------------------- */

    async createRecording(
      db: Database,
      workspaceId: string,
      input: {
        callId: string
        url: string
        durationSeconds?: number | null
        sizeBytes?: number | null
      },
      actorId?: string,
    ): Promise<CallRecordingRow> {
      const rows = await db
        .insert(callRecordings)
        .values({
          workspaceId,
          callId: input.callId,
          url: input.url,
          durationSeconds: input.durationSeconds ?? null,
          sizeBytes: input.sizeBytes ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("call_recordings.create: insert returned no rows")
      return row
    },

    async listRecordingsForCall(
      db: Database,
      workspaceId: string,
      callId: string,
    ): Promise<CallRecordingRow[]> {
      return db
        .select()
        .from(callRecordings)
        .where(
          and(
            eq(callRecordings.workspaceId, workspaceId),
            eq(callRecordings.callId, callId),
            isNull(callRecordings.deletedAt),
          ),
        )
    },
  }
}

export type CallingRepository = ReturnType<typeof createCallingRepository>
