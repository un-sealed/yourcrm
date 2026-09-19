import { and, asc, desc, eq, ilike, isNull, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  aiAgentRuns,
  aiAgents,
  isAiAgentRunStatus,
  isAiAgentStatus,
  isAiAgentTriggerType,
  type AiAgent,
  type AiAgentRun,
} from "../schema/ai-agents"
import { createBaseRepository } from "./base-repository"

/**
 * AI agents repository (spec 36-ai-agents, P0). Tables in
 * `schema/ai-agents.ts`, migration `0400_ai_agents.sql`.
 *
 * Writes this module's OWN two tables and nothing else. An agent cannot
 * change a CRM record, so there is deliberately no method here that
 * touches another module's tables: a proposed change is an
 * `ai_action_requests` row written by the approval queue's repository
 * (spec 38), and applying one goes through the owning module's DOMAIN
 * SERVICE. Reads reach CRM data only through the reports engine, under the
 * caller's row scope, via the assistant's tools.
 *
 * Two things here are contracts rather than convenience:
 *
 *  - `createRun` is IDEMPOTENT against the UNIQUE
 *    (agent_id, trigger_event_id) index and reports `created: false` on
 *    redelivery. The domain service uses that flag to decide whether to
 *    enqueue, which is why a redelivered event never runs an agent — or
 *    spends its tokens — twice.
 *  - `listEnabledByTrigger` enforces "off" in SQL. A disabled agent is
 *    never returned to the dispatcher, so it cannot be run by a branch
 *    somebody forgot.
 */

export class AiAgentRepositoryError extends Error {
  readonly code = "INVALID_AI_AGENT"
  constructor(message: string) {
    super(message)
    this.name = "AiAgentRepositoryError"
  }
}

/** Budget ceilings, mirroring the CHECK constraints and the domain layer. */
export const AI_AGENT_BUDGET_CEILINGS = {
  maxSteps: 12,
  maxToolCalls: 24,
  maxTotalTokens: 200_000,
} as const

export type CreateAiAgentRecordInput = {
  name: string
  description?: string | null
  instructions: string
  model?: string | null
  tools?: readonly string[] | null
  triggerType?: string | null
  triggerEvent?: string | null
  triggerEntityType?: string | null
  ownerId?: string | null
  status?: string | null
  maxSteps?: number | null
  maxToolCalls?: number | null
  maxTotalTokens?: number | null
}

export type UpdateAiAgentRecordInput = Partial<CreateAiAgentRecordInput>

export type CreateAiAgentRunInput = {
  agentId: string
  triggerType: string
  triggerEvent?: string | null
  triggerEventId: string
  triggerPayload?: unknown
  input?: string | null
  entityType?: string | null
  entityId?: string | null
  actorId?: string | null
  actorRole?: string | null
  status?: string | null
  depth?: number | null
  parentRunId?: string | null
  correlationId?: string | null
  error?: string | null
}

export type UpdateAiAgentRunInput = {
  status?: string
  actorRole?: string | null
  steps?: number
  toolCallCount?: number
  proposalCount?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  latencyMs?: number
  costMicros?: number | null
  providerId?: string | null
  model?: string | null
  summary?: string | null
  stepLog?: unknown
  errorCode?: string | null
  error?: string | null
  startedAt?: Date | null
  finishedAt?: Date | null
}

export type AiAgentSearchOptions = {
  workspaceId: string
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
  triggerType?: string
  triggerEvent?: string
}

export type AiAgentRunSearchOptions = {
  workspaceId: string
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  agentId?: string
  status?: string
}

/* ------------------------------- validation ------------------------------- */

export function normalizeAiAgentName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new AiAgentRepositoryError("ai_agent: name must not be empty")
  return trimmed.length > 160 ? trimmed.slice(0, 160) : trimmed
}

export function validateAiAgentStatus(value: string): string {
  if (!isAiAgentStatus(value)) {
    throw new AiAgentRepositoryError(
      `ai_agent: status must be one of disabled, enabled (got '${value}')`,
    )
  }
  return value
}

export function validateAiAgentTriggerType(value: string): string {
  if (!isAiAgentTriggerType(value)) {
    throw new AiAgentRepositoryError(
      `ai_agent: triggerType must be one of manual, event (got '${value}')`,
    )
  }
  return value
}

export function validateAiAgentRunStatus(value: string): string {
  if (!isAiAgentRunStatus(value)) {
    throw new AiAgentRepositoryError(
      `ai_agent_run: status must be one of queued, running, succeeded, failed, exhausted, denied, skipped (got '${value}')`,
    )
  }
  return value
}

/** Tool allowlist: a JSON array of distinct non-empty names, bounded. */
export function validateAiAgentTools(value: readonly string[] | null | undefined): string[] {
  if (value == null) return []
  const names = [...new Set(value.map((name) => name.trim()).filter((name) => name !== ""))]
  if (names.length > 16) {
    throw new AiAgentRepositoryError("ai_agent: at most 16 tools may be allowlisted")
  }
  for (const name of names) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
      throw new AiAgentRepositoryError(`ai_agent: '${name}' is not a valid tool name`)
    }
  }
  return names
}

/**
 * Clamp a budget into [1, ceiling]. The domain layer clamps too; this is
 * the last line before the CHECK constraint, so a caller that skipped the
 * service cannot store an unbounded loop.
 */
export function clampAiAgentBudgetValue(
  value: number | null | undefined,
  fallback: number,
  ceiling: number,
): number {
  const raw = value == null || !Number.isFinite(value) ? fallback : Math.floor(value)
  if (raw < 1) return 1
  return raw > ceiling ? ceiling : raw
}

function counter(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < 0) {
    throw new AiAgentRepositoryError(`ai_agent_run: ${field} must be a non-negative number`)
  }
  return Math.round(value)
}

/* ------------------------------- repository ------------------------------- */

export function createAiAgentsRepository() {
  const base = createBaseRepository(aiAgents)

  function toAgentValues(
    input: UpdateAiAgentRecordInput,
    actorId?: string,
  ): Record<string, unknown> {
    const values: Record<string, unknown> = {}
    if (input.name !== undefined) values.name = normalizeAiAgentName(input.name)
    if (input.description !== undefined) values.description = input.description ?? null
    if (input.instructions !== undefined) values.instructions = input.instructions
    if (input.model !== undefined) values.model = input.model ?? null
    if (input.tools !== undefined) values.tools = validateAiAgentTools(input.tools)
    if (input.triggerType != null) {
      values.triggerType = validateAiAgentTriggerType(input.triggerType)
    }
    if (input.triggerEvent !== undefined) values.triggerEvent = input.triggerEvent ?? null
    if (input.triggerEntityType !== undefined) {
      values.triggerEntityType = input.triggerEntityType ?? null
    }
    if (input.ownerId !== undefined) values.ownerId = input.ownerId ?? null
    if (input.status != null) values.status = validateAiAgentStatus(input.status)
    if (input.maxSteps !== undefined) {
      values.maxSteps = clampAiAgentBudgetValue(
        input.maxSteps,
        6,
        AI_AGENT_BUDGET_CEILINGS.maxSteps,
      )
    }
    if (input.maxToolCalls !== undefined) {
      values.maxToolCalls = clampAiAgentBudgetValue(
        input.maxToolCalls,
        12,
        AI_AGENT_BUDGET_CEILINGS.maxToolCalls,
      )
    }
    if (input.maxTotalTokens !== undefined) {
      values.maxTotalTokens = clampAiAgentBudgetValue(
        input.maxTotalTokens,
        60_000,
        AI_AGENT_BUDGET_CEILINGS.maxTotalTokens,
      )
    }
    if (actorId !== undefined) values.updatedBy = actorId
    return values
  }

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateAiAgentRecordInput,
      actorId?: string,
    ): Promise<AiAgent> {
      const rows = await db
        .insert(aiAgents)
        .values({
          ...toAgentValues(input, actorId),
          workspaceId,
          name: normalizeAiAgentName(input.name),
          instructions: input.instructions,
          tools: validateAiAgentTools(input.tools),
          triggerType: validateAiAgentTriggerType(input.triggerType ?? "manual"),
          // An agent is off until somebody with `run_ai` enables it.
          status: input.status == null ? "disabled" : validateAiAgentStatus(input.status),
          ownerId: input.ownerId ?? actorId ?? null,
          maxSteps: clampAiAgentBudgetValue(input.maxSteps, 6, AI_AGENT_BUDGET_CEILINGS.maxSteps),
          maxToolCalls: clampAiAgentBudgetValue(
            input.maxToolCalls,
            12,
            AI_AGENT_BUDGET_CEILINGS.maxToolCalls,
          ),
          maxTotalTokens: clampAiAgentBudgetValue(
            input.maxTotalTokens,
            60_000,
            AI_AGENT_BUDGET_CEILINGS.maxTotalTokens,
          ),
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new AiAgentRepositoryError("ai_agents.create: insert returned no rows")
      return row
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateAiAgentRecordInput,
      actorId?: string,
    ): Promise<AiAgent | null> {
      const rows = await db
        .update(aiAgents)
        .set({ ...toAgentValues(input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(aiAgents.id, id),
            eq(aiAgents.workspaceId, workspaceId),
            isNull(aiAgents.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<AiAgent | null> {
      // The shared base narrows rows to the BaseRecord columns; re-cast
      // here so callers get the full AiAgent shape.
      return ((await base.findById(db, workspaceId, id)) as AiAgent | null) ?? null
    },

    /** Cursor-paginated definition list with search + trigger/status filters. */
    async search(db: Database, opts: AiAgentSearchOptions) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const match = or(ilike(aiAgents.name, q), ilike(aiAgents.description, q))
        if (match) conditions.push(match)
      }
      if (opts.status) conditions.push(eq(aiAgents.status, validateAiAgentStatus(opts.status)))
      if (opts.triggerType) {
        conditions.push(eq(aiAgents.triggerType, validateAiAgentTriggerType(opts.triggerType)))
      }
      if (opts.triggerEvent) conditions.push(eq(aiAgents.triggerEvent, opts.triggerEvent))
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as AiAgent[], pagination: result.pagination }
    },

    /**
     * The dispatcher's hot path: every live, ENABLED agent in this
     * workspace listening to this event. "Off" is enforced in SQL.
     */
    async listEnabledByTrigger(
      db: Database,
      workspaceId: string,
      triggerEvent: string,
    ): Promise<AiAgent[]> {
      return db
        .select()
        .from(aiAgents)
        .where(
          and(
            eq(aiAgents.workspaceId, workspaceId),
            eq(aiAgents.triggerEvent, triggerEvent),
            eq(aiAgents.triggerType, "event"),
            eq(aiAgents.status, "enabled"),
            isNull(aiAgents.deletedAt),
          ),
        )
        .orderBy(asc(aiAgents.createdAt))
    },

    async markAgentRan(
      db: Database,
      workspaceId: string,
      id: string,
      at: Date = new Date(),
    ): Promise<void> {
      await db
        .update(aiAgents)
        .set({ lastRunAt: at })
        .where(and(eq(aiAgents.id, id), eq(aiAgents.workspaceId, workspaceId)))
    },

    /* --------------------------------- runs -------------------------------- */

    /**
     * IDEMPOTENT run creation. `ai_agent_runs_event_idx` is UNIQUE over
     * (agent_id, trigger_event_id), so a redelivered event conflicts and
     * the existing run comes back with `created: false`. Callers use that
     * flag to decide whether to enqueue — which is why a redelivery never
     * runs the agent, or spends its tokens, a second time.
     */
    async createRun(
      db: Database,
      workspaceId: string,
      input: CreateAiAgentRunInput,
    ): Promise<{ run: AiAgentRun; created: boolean }> {
      const inserted = await db
        .insert(aiAgentRuns)
        .values({
          workspaceId,
          agentId: input.agentId,
          triggerType: validateAiAgentTriggerType(input.triggerType),
          triggerEvent: input.triggerEvent ?? null,
          triggerEventId: input.triggerEventId,
          triggerPayload: input.triggerPayload ?? null,
          input: input.input ?? null,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          actorId: input.actorId ?? null,
          actorRole: input.actorRole ?? null,
          status: validateAiAgentRunStatus(input.status ?? "queued"),
          depth: input.depth ?? 0,
          parentRunId: input.parentRunId ?? null,
          correlationId: input.correlationId ?? null,
          error: input.error ?? null,
        })
        .onConflictDoNothing({ target: [aiAgentRuns.agentId, aiAgentRuns.triggerEventId] })
        .returning()
      const created = inserted[0]
      if (created) return { run: created, created: true }

      const existing = await db
        .select()
        .from(aiAgentRuns)
        .where(
          and(
            eq(aiAgentRuns.workspaceId, workspaceId),
            eq(aiAgentRuns.agentId, input.agentId),
            eq(aiAgentRuns.triggerEventId, input.triggerEventId),
          ),
        )
        .limit(1)
      const row = existing[0]
      if (!row) throw new AiAgentRepositoryError("ai_agent_runs.create: conflict without a row")
      return { run: row, created: false }
    },

    async findRunById(db: Database, workspaceId: string, id: string): Promise<AiAgentRun | null> {
      const rows = await db
        .select()
        .from(aiAgentRuns)
        .where(and(eq(aiAgentRuns.id, id), eq(aiAgentRuns.workspaceId, workspaceId)))
        .limit(1)
      return rows[0] ?? null
    },

    async searchRuns(db: Database, opts: AiAgentRunSearchOptions) {
      const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200)
      const conditions: SQL[] = [eq(aiAgentRuns.workspaceId, opts.workspaceId)]
      if (opts.agentId) conditions.push(eq(aiAgentRuns.agentId, opts.agentId))
      if (opts.status)
        conditions.push(eq(aiAgentRuns.status, validateAiAgentRunStatus(opts.status)))
      const ordering =
        opts.order === "asc" ? asc(aiAgentRuns.createdAt) : desc(aiAgentRuns.createdAt)
      const rows = await db
        .select()
        .from(aiAgentRuns)
        .where(and(...conditions))
        .orderBy(ordering)
        .limit(limit + 1)
      const hasMore = rows.length > limit
      const data = hasMore ? rows.slice(0, limit) : rows
      const last = data[data.length - 1]
      return {
        data,
        pagination: { nextCursor: hasMore ? (last?.id ?? null) : null, limit },
      }
    },

    async updateRun(
      db: Database,
      workspaceId: string,
      id: string,
      patch: UpdateAiAgentRunInput,
    ): Promise<AiAgentRun | null> {
      const values: Record<string, unknown> = { updatedAt: new Date() }
      if (patch.status !== undefined) values.status = validateAiAgentRunStatus(patch.status)
      if (patch.actorRole !== undefined) values.actorRole = patch.actorRole
      if (patch.steps !== undefined) values.steps = counter(patch.steps, "steps")
      if (patch.toolCallCount !== undefined) {
        values.toolCallCount = counter(patch.toolCallCount, "toolCallCount")
      }
      if (patch.proposalCount !== undefined) {
        values.proposalCount = counter(patch.proposalCount, "proposalCount")
      }
      if (patch.promptTokens !== undefined) {
        values.promptTokens = counter(patch.promptTokens, "promptTokens")
      }
      if (patch.completionTokens !== undefined) {
        values.completionTokens = counter(patch.completionTokens, "completionTokens")
      }
      if (patch.totalTokens !== undefined) {
        values.totalTokens = counter(patch.totalTokens, "totalTokens")
      }
      if (patch.latencyMs !== undefined) values.latencyMs = counter(patch.latencyMs, "latencyMs")
      if (patch.costMicros !== undefined) values.costMicros = patch.costMicros
      if (patch.providerId !== undefined) values.providerId = patch.providerId
      if (patch.model !== undefined) values.model = patch.model
      if (patch.summary !== undefined) values.summary = patch.summary
      if (patch.stepLog !== undefined) values.stepLog = patch.stepLog
      if (patch.errorCode !== undefined) values.errorCode = patch.errorCode
      if (patch.error !== undefined) values.error = patch.error
      if (patch.startedAt !== undefined) values.startedAt = patch.startedAt
      if (patch.finishedAt !== undefined) values.finishedAt = patch.finishedAt

      const rows = await db
        .update(aiAgentRuns)
        .set(values)
        .where(and(eq(aiAgentRuns.id, id), eq(aiAgentRuns.workspaceId, workspaceId)))
        .returning()
      return rows[0] ?? null
    },
  }
}

export type AiAgentsRepository = ReturnType<typeof createAiAgentsRepository>
