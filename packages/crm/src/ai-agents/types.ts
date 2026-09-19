import type { AiProvider, AiToolDefinition } from "@yourcrm/ai"
import type { AiModelPricingTable, AiToolExecution } from "../ai-assistant/types"
import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * AI agent ports (spec 36-ai-agents, P0).
 *
 * An agent is a NAMED, SCOPED, TRIGGERABLE LLM LOOP: stored instructions,
 * an allowlisted subset of the assistant's read tools, a trigger, an owner
 * whose permissions it inherits, and hard budgets. Everything it can do is
 * one of these ports, and that is the whole safety argument:
 *
 *  - `AiProvider` (from `@yourcrm/ai`, imported — not mirrored) turns
 *    messages into text and tool calls. It never touches CRM data.
 *  - `AiToolRegistry` is the ASSISTANT's read-only tool set
 *    (`../ai-assistant/tools.ts`), reused verbatim. There is no second
 *    query path, and `createAiToolRegistry` already refuses to register a
 *    tool whose `access` is not `"read"`.
 *  - `AiActionProposalPort` is the ONLY port with a write in its future,
 *    and it does not write: `requestAction` records an
 *    `ai_action_request` for a human (`../ai-governance`). There is
 *    deliberately no `AiActionApplierPort` here, no domain service, and no
 *    repository — an agent physically cannot reach a mutation.
 *  - `AiAgentStore` covers this module's OWN two tables and nothing else.
 *  - `AiAgentRunQueuePort` is the BullMQ seam: domain code never imports
 *    a transport.
 *  - `AiAgentActorRoleResolver` re-reads the owner's LIVE workspace role
 *    at execution time, exactly as `WorkflowActorRoleResolver` does. The
 *    product has one answer to "how does a non-human actor inherit
 *    permissions", and this is it.
 *
 * `@yourcrm/crm` has no database dependency, so the store stays
 * structural: `apps/api` adapts the drizzle repository, and the hermetic
 * tests satisfy the same shape with in-memory fakes.
 */

/* --------------------------------- records -------------------------------- */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type AiAgent = Record<string, unknown> & {
  id: string
  workspaceId: string
  name: string
  instructions: string
  status: string
  triggerType: string
}

/** One execution. The accounting row: steps, tokens, latency, cost, outcome. */
export type AiAgentRun = Record<string, unknown> & {
  id: string
  workspaceId: string
  agentId: string
  status: string
  triggerEventId: string
}

export type AiAgentListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  status?: string
  triggerType?: string
  triggerEvent?: string
  query?: string
}

export type AiAgentListResult = {
  data: AiAgent[]
  pagination: { nextCursor: string | null; limit: number }
}

export type AiAgentRunListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  agentId?: string
  status?: string
}

export type AiAgentRunListResult = {
  data: AiAgentRun[]
  pagination: { nextCursor: string | null; limit: number }
}

/* ---------------------------------- tools --------------------------------- */

/**
 * The context a tool runs in: the OWNER's identity and LIVE role, plus the
 * attribution every AI action must carry. The model supplies none of it —
 * it supplies arguments only.
 */
export type AiAgentToolContext = ServiceContext & {
  agentId: string
  runId: string
  model: string
}

/**
 * What an agent tool may be.
 *
 *  - `"read"` — an assistant read tool, executed directly under the
 *    owner's permissions.
 *  - `"propose"` — records an `ai_action_request` through
 *    `AiActionProposalPort` and returns; nothing changes until a human
 *    approves.
 *
 * There is no third member, and `createAiAgentToolRegistry` throws on
 * anything else. A `"write"` tool cannot be added without deleting that
 * check, which is the point.
 */
export type AiAgentToolAccess = "read" | "propose"

export type AiAgentTool = {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly access: AiAgentToolAccess
  execute(ctx: AiAgentToolContext, args: Record<string, unknown>): Promise<AiToolExecution>
}

export type AiAgentToolRegistry = {
  /** Every tool an agent in this workspace could be granted. */
  list(): AiAgentTool[]
  get(name: string): AiAgentTool | null
  /** Names, for validating a definition's allowlist at save time. */
  names(): string[]
  /** The allowlisted subset, in registry order. Unknown names are dropped. */
  subset(names: readonly string[]): AiAgentTool[]
  /** Provider-form definitions for exactly those tools. */
  definitions(names: readonly string[]): AiToolDefinition[]
}

/** One tool invocation, as recorded on the run and in the audit trail. */
export type AiAgentToolCallReport = {
  id: string
  name: string
  access: AiAgentToolAccess
  arguments: Record<string, unknown>
  outcome: "succeeded" | "failed" | "denied" | "blocked"
  summary: string
  durationMs: number
  /** Set when a `propose` tool queued an `ai_action_request`. */
  requestId?: string | null
}

/* --------------------------------- trigger -------------------------------- */

/**
 * The triggering event, in the `@yourcrm/events` envelope shape restated
 * structurally — same reason the automation dispatcher does it: any future
 * transport (Redis fan-out, webhook receiver, cron tick) can feed the
 * dispatcher without a new contract.
 */
export type AiAgentTriggerEnvelope = {
  eventId: string
  event: string
  workspaceId: string
  actorId?: string
  actorType?: string
  entityType?: string
  entityId?: string
  before?: unknown
  after?: unknown
  correlationId?: string
}

/* ---------------------------------- ports --------------------------------- */

export type AiAgentStore = {
  list(workspaceId: string, query: AiAgentListQuery): Promise<AiAgentListResult>
  findById(workspaceId: string, id: string): Promise<AiAgent | null>
  create(workspaceId: string, input: Record<string, unknown>, actorId?: string): Promise<AiAgent>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<AiAgent | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  /** Live, enabled definitions listening to this event. */
  listEnabledByTrigger(workspaceId: string, triggerEvent: string): Promise<AiAgent[]>
  markAgentRan(workspaceId: string, id: string, at: Date): Promise<void>
  /**
   * Insert a run, or return the existing one for the same
   * (agentId, triggerEventId). `created: false` means this event has
   * already been processed — the caller must NOT enqueue it again. Backed
   * by a UNIQUE index, so idempotency is a database result and not a
   * decision the service makes in memory.
   */
  createRun(
    workspaceId: string,
    input: Record<string, unknown>,
  ): Promise<{ run: AiAgentRun; created: boolean }>
  findRunById(workspaceId: string, id: string): Promise<AiAgentRun | null>
  listRuns(workspaceId: string, query: AiAgentRunListQuery): Promise<AiAgentRunListResult>
  updateRun(
    workspaceId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<AiAgentRun | null>
}

/** One enqueue request. Carries no actor: the run names the owner. */
export type AiAgentRunJobRequest = {
  workspaceId: string
  agentId: string
  runId: string
  triggerEventId: string
  correlationId?: string
}

/** The queue seam. Domain code must never import BullMQ. */
export type AiAgentRunQueuePort = {
  enqueueAiAgentRun(request: AiAgentRunJobRequest): Promise<void>
}

/**
 * Resolves an actor's LIVE workspace role. Returns `null` when the actor
 * is not (or no longer) a member — in which case the run is refused, never
 * downgraded to a default role.
 */
export type AiAgentActorRoleResolver = (
  workspaceId: string,
  actorId: string,
) => Promise<string | null>

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type AiAgentAuditInput = {
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

export type AiAgentServiceContext = ServiceContext

export type AiAgentServiceDeps = {
  store: AiAgentStore
  /** The LLM port itself — `@yourcrm/ai`, injected, never constructed. */
  provider: AiProvider
  /**
   * The agent's tool set: the assistant's read tools, reused verbatim,
   * plus at most the `propose` tool built over `AiActionProposalPort`
   * (`./tools.ts`). Note what is NOT in this dependency list — an
   * applier, a domain service, a repository, a queue of mutations. An
   * agent's entire reach is this registry.
   */
  tools: AiAgentToolRegistry
  audit: AuditWriter<AiAgentAuditInput>
  events?: EventEmitter
  queue: AiAgentRunQueuePort
  /** Live role lookup for the agent's OWNER, at execution time. */
  resolveActorRole: AiAgentActorRoleResolver
  pricing?: AiModelPricingTable
  /** Injectable clock — hermetic tests assert exact timestamps. */
  now?: () => Date
  /** Injectable id source — hermetic tests assert exact run ids. */
  newId?: () => string
}

/* --------------------------------- results -------------------------------- */

/** Why a matched agent did not produce a runnable run. */
export type AiAgentDispatchSkipReason = "duplicate" | "queue_failed"

export type AiAgentDispatchDecision = {
  agentId: string
  runId: string
  outcome: "queued" | AiAgentDispatchSkipReason
}

export type AiAgentDispatchResult = {
  event: string
  eventId: string
  matched: number
  decisions: AiAgentDispatchDecision[]
}

/** What one execution produced. `status` is the terminal run status. */
export type AiAgentRunOutcome = {
  runId: string
  status: string
  steps: number
  toolCalls: AiAgentToolCallReport[]
  /** Proposals queued for human approval. Nothing was changed. */
  proposalCount: number
  totalTokens: number
  latencyMs: number
  costMicros: number | null
  summary: string
  error?: string
}

export type AiAgentWithRuns = {
  agent: AiAgent
  runs: AiAgentRun[]
}
