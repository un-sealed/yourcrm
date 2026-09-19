import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * People service ports (the pattern every module agent mirrors).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository (`people-repository.ts`) and
 * `writeAudit` to them. Any object with matching methods satisfies the
 * port — including the `createStore` fake in hermetic tests.
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type PersonRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type PersonContact = Record<string, unknown> & {
  id: string
  personId: string
}

export type PersonWithContacts = {
  person: PersonRecord
  emails: PersonContact[]
  phones: PersonContact[]
}

export type PersonListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
}

export type PersonListResult = {
  data: PersonRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type PeopleStore = {
  list(workspaceId: string, query: PersonListQuery): Promise<PersonListResult>
  findById(workspaceId: string, id: string): Promise<PersonRecord | null>
  findWithContacts(workspaceId: string, id: string): Promise<PersonWithContacts | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<PersonRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<PersonRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type PersonAuditInput = {
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

export type PeopleServiceContext = ServiceContext

export type PeopleServiceDeps = {
  store: PeopleStore
  audit: AuditWriter<PersonAuditInput>
  events?: EventEmitter
}
