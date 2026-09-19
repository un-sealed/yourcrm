import type { ServiceContext } from "../index"

/**
 * Deals service ports (mirrors the people module pattern).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository (`deals-repository.ts`) and
 * `writeAudit` to them. Any object with matching methods satisfies the
 * port — including the `createStore` fake in hermetic tests.
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type DealRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type DealListQuery = {
  limit?: number
  cursor?: string
  sort?: string
  order?: "asc" | "desc"
  query?: string
  stage?: string
  pipelineId?: string
}

export type DealListResult = {
  data: DealRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type DealsStore = {
  list(workspaceId: string, query: DealListQuery): Promise<DealListResult>
  findById(workspaceId: string, id: string): Promise<DealRecord | null>
  create(workspaceId: string, input: Record<string, unknown>, actorId?: string): Promise<DealRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<DealRecord | null>
  changeStage(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<DealRecord | null>
  close(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<DealRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type DealAuditInput = {
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

export type AuditWriter = (input: DealAuditInput) => Promise<unknown>

export type EventEmitter = {
  emit(event: {
    event: string
    workspaceId: string
    actorId?: string
    entityType?: string
    entityId?: string
    before?: unknown
    after?: unknown
    correlationId?: string
  }): Promise<void>
}

export type DealsServiceContext = ServiceContext

export type DealsServiceDeps = {
  store: DealsStore
  audit: AuditWriter
  events?: EventEmitter
}
