import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Tasks service ports (mirrors the people module pattern).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository (`tasks-repository.ts`) and
 * `writeAudit` to them. Any object with matching methods satisfies the
 * port — including the `createStore` fake in hermetic tests.
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type TaskRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type TaskListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
  priority?: string
  assigneeId?: string
  /** When true, scope the list to tasks assigned to the current actor. */
  mine?: boolean
  overdue?: boolean
  dueBefore?: string
  dueAfter?: string
}

export type TaskListResult = {
  data: TaskRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type TasksStore = {
  list(workspaceId: string, query: TaskListQuery): Promise<TaskListResult>
  findById(workspaceId: string, id: string): Promise<TaskRecord | null>
  create(workspaceId: string, input: Record<string, unknown>, actorId?: string): Promise<TaskRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<TaskRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type TaskAuditInput = {
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

export type TasksServiceContext = ServiceContext

export type TasksServiceDeps = {
  store: TasksStore
  audit: AuditWriter<TaskAuditInput>
  events?: EventEmitter
}
