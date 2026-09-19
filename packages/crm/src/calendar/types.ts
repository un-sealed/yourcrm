import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Calendar service ports (mirrors the people module pattern — see
 * `../people/types.ts` for the canonical explanation).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository (`calendar-repository.ts`) and
 * `writeAudit` to them. Any object with matching methods satisfies the
 * port — including the `createStore` fake in hermetic tests.
 *
 * SCOPE (spec 13-calendar, P0): internal events only. No Google/Microsoft
 * sync, no CalDAV, no OAuth, no booking pages, no recurrence. Timestamps are
 * stored UTC (`timestamptz`) by the repository; rendering in the workspace's
 * local timezone is a read-side concern (`../calendar/timezone.ts`).
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type CalendarEventRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type CalendarAttendeeRecord = Record<string, unknown> & {
  id: string
  eventId: string
}

export type CalendarEventWithAttendees = {
  event: CalendarEventRecord
  attendees: CalendarAttendeeRecord[]
}

export type CalendarEventListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
  /** Inclusive UTC ISO range bounds: return events overlapping [from, to]. */
  from?: string
  to?: string
  personId?: string
  companyId?: string
  dealId?: string
}

export type CalendarEventListResult = {
  data: CalendarEventRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type CalendarStore = {
  list(workspaceId: string, query: CalendarEventListQuery): Promise<CalendarEventListResult>
  findById(workspaceId: string, id: string): Promise<CalendarEventRecord | null>
  findWithAttendees(workspaceId: string, id: string): Promise<CalendarEventWithAttendees | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<CalendarEventRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<CalendarEventRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
  /** `workspaces.timezone` (IANA name, e.g. `"America/New_York"`). Defaults to `"UTC"`. */
  getWorkspaceTimezone(workspaceId: string): Promise<string>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type CalendarAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type CalendarServiceContext = ServiceContext

export type CalendarServiceDeps = {
  store: CalendarStore
  audit: AuditWriter<CalendarAuditInput>
  events?: EventEmitter
}
