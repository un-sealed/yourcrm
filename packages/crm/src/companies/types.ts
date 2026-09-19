import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Companies service ports (mirrors the people module pattern).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository (`companies-repository.ts`) and
 * `writeAudit` to them. Any object with matching methods satisfies the
 * port — including the `createStore` fake in hermetic tests.
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type CompanyRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type CompanyAddressRecord = Record<string, unknown> & {
  id: string
  companyId: string
}

export type CompanyWithAddresses = {
  company: CompanyRecord
  addresses: CompanyAddressRecord[]
  children: CompanyRecord[]
}

export type CompanyListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
  industry?: string
}

export type CompanyListResult = {
  data: CompanyRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type CompaniesStore = {
  list(workspaceId: string, query: CompanyListQuery): Promise<CompanyListResult>
  findById(workspaceId: string, id: string): Promise<CompanyRecord | null>
  findWithAddresses(
    workspaceId: string,
    id: string,
  ): Promise<{ company: CompanyRecord; addresses: CompanyAddressRecord[] } | null>
  listChildren(workspaceId: string, parentId: string): Promise<CompanyRecord[]>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<CompanyRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<CompanyRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type CompanyAuditInput = {
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

export type CompaniesServiceContext = ServiceContext

export type CompaniesServiceDeps = {
  store: CompaniesStore
  audit: AuditWriter<CompanyAuditInput>
  events?: EventEmitter
}
