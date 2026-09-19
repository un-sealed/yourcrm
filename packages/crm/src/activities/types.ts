import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Activities service ports (mirrors the people module pattern).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository (`activities-repository.ts`) and
 * `writeAudit` to them. Any object with matching methods satisfies the
 * port — including the `createStore` fake in hermetic tests.
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type ActivityRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type ActivityListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  type?: string
  status?: string
  subjectType?: string
  subjectId?: string
}

export type ActivityTimelineQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  subjectType: string
  subjectId: string
}

export type ActivityListResult = {
  data: ActivityRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type ActivitiesStore = {
  list(workspaceId: string, query: ActivityListQuery): Promise<ActivityListResult>
  timeline(workspaceId: string, query: ActivityTimelineQuery): Promise<ActivityListResult>
  findById(workspaceId: string, id: string): Promise<ActivityRecord | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<ActivityRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<ActivityRecord | null>
  complete(workspaceId: string, id: string, actorId?: string): Promise<ActivityRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type ActivityAuditInput = {
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

export type ActivitiesServiceContext = ServiceContext

export type ActivitiesServiceDeps = {
  store: ActivitiesStore
  audit: AuditWriter<ActivityAuditInput>
  events?: EventEmitter
}
