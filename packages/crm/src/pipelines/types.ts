import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Pipelines service ports (mirrors `people/types.ts`).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository (`pipelines-repository.ts`) and
 * `writeAudit` to them. Any object with matching methods satisfies the
 * port — including the `createStore` fake in hermetic tests.
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type PipelineRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type PipelineStageRecord = Record<string, unknown> & {
  id: string
  pipelineId: string
  position: number
  probability: number
  isWon: boolean
  isLost: boolean
}

export type PipelineWithStages = {
  pipeline: PipelineRecord
  stages: PipelineStageRecord[]
}

export type PipelineListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
}

export type PipelineListResult = {
  data: PipelineRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type PipelinesStore = {
  list(workspaceId: string, query: PipelineListQuery): Promise<PipelineListResult>
  findById(workspaceId: string, id: string): Promise<PipelineRecord | null>
  findWithStages(workspaceId: string, id: string): Promise<PipelineWithStages | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<PipelineWithStages>
  createDefault(workspaceId: string, actorId?: string): Promise<PipelineWithStages>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<PipelineRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
  addStage(
    workspaceId: string,
    pipelineId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<PipelineStageRecord | null>
  updateStage(
    workspaceId: string,
    pipelineId: string,
    stageId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<PipelineStageRecord | null>
  removeStage(workspaceId: string, pipelineId: string, stageId: string): Promise<boolean>
  reorderStages(
    workspaceId: string,
    pipelineId: string,
    orderedIds: string[],
    actorId?: string,
  ): Promise<PipelineStageRecord[]>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type PipelineAuditInput = {
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

export type PipelinesServiceContext = ServiceContext

export type PipelinesServiceDeps = {
  store: PipelinesStore
  audit: AuditWriter<PipelineAuditInput>
  events?: EventEmitter
}
