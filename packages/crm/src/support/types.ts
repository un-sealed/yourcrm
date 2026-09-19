import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Support/Ticketing service ports (spec 21-support, P0). Mirrors the people
 * reference module; status lifecycle mirrors the quotes explicit-transition
 * pattern.
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository
 * (`packages/database/src/repositories/support-repository.ts`) and
 * `writeAudit` to them. Any object with matching methods satisfies the
 * port — including the `createStore` fake in hermetic tests.
 *
 * All exports here are prefixed `SupportTicket*` rather than `Ticket*`: the
 * `@yourcrm/crm` barrel (`../index.ts`) is `export *` across every module, so
 * a bare `Ticket` name would be a fresh TS2308 collision risk for whichever
 * module claims it next (see `../ports.ts` for the story on how that already
 * happened once with `AuditWriter`/`EventEmitter`).
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type SupportTicketRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type SupportTicketCommentRecord = Record<string, unknown> & {
  id: string
  ticketId: string
  isInternal: boolean
}

export type SupportTicketWithComments = {
  ticket: SupportTicketRecord
  /** Every comment, public and internal. STAFF VIEW ONLY — see `service.ts`. */
  comments: SupportTicketCommentRecord[]
}

export type SupportTicketListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
  priority?: string
  assigneeId?: string
  requesterId?: string
}

export type SupportTicketListResult = {
  data: SupportTicketRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type SupportTicketStore = {
  list(workspaceId: string, query: SupportTicketListQuery): Promise<SupportTicketListResult>
  findById(workspaceId: string, id: string): Promise<SupportTicketRecord | null>
  findWithComments(
    workspaceId: string,
    id: string,
  ): Promise<{ ticket: SupportTicketRecord; comments: SupportTicketCommentRecord[] } | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<SupportTicketRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<SupportTicketRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
  addComment(
    workspaceId: string,
    ticketId: string,
    input: Record<string, unknown>,
    actorId: string,
  ): Promise<SupportTicketCommentRecord>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type SupportTicketAuditInput = {
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

export type SupportTicketServiceContext = ServiceContext

export type SupportTicketServiceDeps = {
  store: SupportTicketStore
  audit: AuditWriter<SupportTicketAuditInput>
  events?: EventEmitter
  /** Injectable clock — hermetic tests assert exact SLA due timestamps. */
  now?: () => Date
}
