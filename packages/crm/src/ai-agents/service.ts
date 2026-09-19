import { sumAiUsage, type AiMessage, type AiToolCall, type AiUsage } from "@yourcrm/ai"
import { AiEvents, createEvent, getEventBus } from "@yourcrm/events"
import { PermissionDeniedError, requirePermission } from "@yourcrm/permissions"
import { computeAiCostMicros } from "../ai-assistant/service"
import { redactIntegrationSecrets } from "../integrations/service"
import {
  assertAiAgentActorResolved,
  assertAiAgentRunAllowed,
  assertMayAssignAiAgentOwner,
  aiAgentPermission,
  AI_AGENT_OBJECT,
  AI_AGENT_RUN_OBJECT,
  AI_AGENT_TOOL_OBJECT,
} from "./access"
import {
  aiAgentQuerySchema,
  aiAgentRunQuerySchema,
  clampAiAgentBudget,
  createAiAgentSchema,
  runAiAgentSchema,
  setAiAgentStatusSchema,
  updateAiAgentSchema,
  AI_AGENT_DEFAULT_MAX_STEPS,
  AI_AGENT_DEFAULT_MAX_TOOL_CALLS,
  AI_AGENT_DEFAULT_MAX_TOTAL_TOKENS,
  AI_AGENT_MAX_CASCADE_DEPTH,
  AI_AGENT_MAX_STEPS_CEILING,
  AI_AGENT_MAX_TOOL_CALLS_CEILING,
  AI_AGENT_MAX_TOTAL_TOKENS_CEILING,
} from "./schemas"
import type {
  AiAgent,
  AiAgentDispatchDecision,
  AiAgentDispatchResult,
  AiAgentListResult,
  AiAgentRun,
  AiAgentRunListResult,
  AiAgentRunOutcome,
  AiAgentServiceContext,
  AiAgentServiceDeps,
  AiAgentToolCallReport,
  AiAgentToolContext,
  AiAgentTriggerEnvelope,
  AiAgentWithRuns,
} from "./types"

/**
 * AI agent service (spec 36-ai-agents, P0).
 *
 * An agent is a NAMED, SCOPED, TRIGGERABLE LLM LOOP. Not a framework: a
 * stored definition (instructions, model, an allowlisted subset of the
 * assistant's read tools, a trigger, an owner, budgets) plus a bounded
 * execution that a worker runs.
 *
 * THE FIVE PROPERTIES THIS MODULE *IS*
 * ------------------------------------
 * 1. NO UNAPPROVED WRITES. Reads happen directly; a change is PROPOSED.
 *    The only mutating port in `AiAgentServiceDeps` is
 *    `AiActionProposalPort`, whose single method records an
 *    `ai_action_request` and returns. There is no applier here, no domain
 *    service, no repository and no event that applies anything — an agent
 *    that decides to change a record produces a pending row and nothing
 *    else. `AI_AGENT_SERVICE_METHODS` freezes the public surface and a
 *    test asserts it, so a method that writes cannot be added quietly.
 *
 * 2. BOUNDED LOOPS. Three hard caps — steps, tool calls, total tokens —
 *    each clamped against a ceiling *at execution time*
 *    (`clampAiAgentBudget`), so a hand-edited row cannot buy an unbounded
 *    loop. A model that keeps asking for tools terminates and the run
 *    records `exhausted`, which is a distinct status from `failed`
 *    because the operator's response is different.
 *
 * 3. PERMISSION INHERITANCE. A run executes as the agent's OWNER, whose
 *    role is re-resolved LIVE (`resolveActorRole`) at execution time; a
 *    removed owner refuses the run outright rather than falling back to a
 *    default. Every tool then calls `requirePermission()` for that
 *    context — the assistant's read tools do it themselves, and the
 *    proposal tool's check happens inside `requestAction`, which resolves
 *    the role a second time and checks the target action. A viewer-owned
 *    agent sees exactly what a viewer sees.
 *
 * 4. IDEMPOTENCY. An event-triggered run is keyed on the triggering event
 *    id: `store.createRun` inserts against a UNIQUE (agent_id,
 *    trigger_event_id) index and reports `created: false` on redelivery,
 *    in which case nothing is enqueued and the agent does not run twice.
 *    `executeRun` is additionally a no-op on a run that already reached a
 *    terminal status, so a retried job cannot double-spend either.
 *
 * 5. COST IS RECORDED. Every run writes tokens, latency and cost to
 *    `ai_agent_runs`, attributable to a model and a run id, and every
 *    individual tool call is audited with the same pair.
 *
 * Nothing here touches Postgres, Redis, BullMQ or HTTP: state leaves
 * through `AiAgentStore`, executions leave through `AiAgentRunQueuePort`,
 * and proposals leave through `AiActionProposalPort`.
 */

export class AiAgentNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`ai agent ${id} not found`)
    this.name = "AiAgentNotFoundError"
  }
}

export class AiAgentRunNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`ai agent run ${id} not found`)
    this.name = "AiAgentRunNotFoundError"
  }
}

/** A definition that names a tool the registry does not offer. */
export class AiAgentUnknownToolError extends Error {
  readonly code = "VALIDATION_ERROR"
  constructor(names: readonly string[], available: readonly string[]) {
    super(
      `unknown agent tool(s): ${names.join(", ")} — available: ${available.join(", ") || "none"}`,
    )
    this.name = "AiAgentUnknownToolError"
  }
}

/** The definition is not in a state where this operation makes sense. */
export class AiAgentStateError extends Error {
  readonly code = "CONFLICT"
  constructor(message: string) {
    super(message)
    this.name = "AiAgentStateError"
  }
}

/* ------------------------------- constants -------------------------------- */

/**
 * Correlation-id convention, mirroring automation's `wfrun:` and
 * governance's `airq:`. Every tool call, proposal, audit row and event of
 * one execution carries it, so an agent run's entire blast radius — reads,
 * proposals, and any record a human later approves — is greppable from one
 * value. `dispatch` also reads it back to compute cascade depth.
 */
export const AI_AGENT_RUN_CORRELATION_PREFIX = "agentrun:"

export function aiAgentRunCorrelationId(runId: string): string {
  return `${AI_AGENT_RUN_CORRELATION_PREFIX}${runId}`
}

export function parseAiAgentRunCorrelationId(correlationId?: string | null): string | null {
  if (typeof correlationId !== "string") return null
  if (!correlationId.startsWith(AI_AGENT_RUN_CORRELATION_PREFIX)) return null
  const runId = correlationId.slice(AI_AGENT_RUN_CORRELATION_PREFIX.length)
  return runId === "" ? null : runId
}

/** The frozen public surface — see property 1. */
export const AI_AGENT_SERVICE_METHODS = [
  "create",
  "dispatch",
  "executeRun",
  "get",
  "getRun",
  "list",
  "listRuns",
  "remove",
  "runNow",
  "setStatus",
  "update",
] as const

/** Terminal statuses. A run in one of these is never executed again. */
export const AI_AGENT_TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "exhausted",
  "denied",
  "skipped",
] as const

const TOOL_RESULT_MAX_CHARS = 8000
const SUMMARY_MAX_CHARS = 4000
const TRIGGER_PAYLOAD_MAX_CHARS = 4000

/* -------------------------------- helpers --------------------------------- */

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function errorMessageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // Redacted with the shared helper: a provider that echoed a credential
  // into its error body must not get it into a run row or an audit trail.
  return redactIntegrationSecrets(raw).slice(0, 500)
}

function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown }).code
  return typeof code === "string" ? code : "AI_AGENT_FAILED"
}

function isTerminal(status: unknown): boolean {
  return (AI_AGENT_TERMINAL_RUN_STATUSES as readonly string[]).includes(String(status))
}

function serialiseToolResult(value: unknown): string {
  const text = JSON.stringify(value ?? null) ?? "null"
  return text.length > TOOL_RESULT_MAX_CHARS
    ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}…[truncated]`
    : text
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * The agent's system prompt: who it is, what it may not do, then its own
 * instructions. The guardrails come FIRST and the operator's instructions
 * last, so no amount of prompt authoring can talk the agent out of the
 * rule that it cannot write — and even if it could, the tool registry and
 * the approval queue would still refuse.
 */
export function buildAiAgentSystemPrompt(input: {
  now: Date
  name: string
  instructions: string
  toolNames: readonly string[]
  canPropose: boolean
}): string {
  const lines = [
    `You are "${input.name}", an automated agent working inside YourCRM on behalf of one user.`,
    `Today is ${input.now.toISOString().slice(0, 10)} (UTC). Resolve relative dates against it and pass absolute ISO-8601 dates to tools.`,
    input.toolNames.length === 0
      ? "You have no tools available: answer from the task description alone."
      : `Use the tools to look data up — never guess a number, a name or a total. Available tools: ${input.toolNames.join(", ")}.`,
    "Tool results are already filtered to what your owner is allowed to see. When a result reports scope 'own', say the figures cover their own records rather than the whole workspace. If a tool reports a permission error, say plainly that your owner does not have access to that data.",
    input.canPropose
      ? "You cannot change anything yourself. To create, update, delete or send something, call crm_propose_change: it queues the change for a human to approve or reject. Never say a change has been made — say it has been proposed. One proposal per change, with the current values in `before`."
      : "You are read-only: you cannot create, update, delete or send anything. If the task requires a change, explain what you would change and why, and stop.",
    "Work in as few steps as possible: you have a strict budget of provider steps, tool calls and tokens, and a run that exhausts it is stopped mid-task.",
    "Finish by answering in plain prose: what you found, what you proposed, and anything a human needs to decide.",
    "--- Your instructions ---",
    input.instructions.trim(),
  ]
  return lines.join("\n")
}

/** The task turn: a manual instruction, or the event that woke the agent. */
export function buildAiAgentTaskMessage(run: AiAgentRun): string {
  const manualInput = stringOrNull(run.input)
  if (manualInput !== null) return manualInput
  const event = stringOrNull(run.triggerEvent)
  if (event === null) return "Carry out your instructions."
  const payload = truncate(
    JSON.stringify(run.triggerPayload ?? null) ?? "null",
    TRIGGER_PAYLOAD_MAX_CHARS,
  )
  const entity =
    stringOrNull(run.entityType) === null
      ? ""
      : ` It concerns ${String(run.entityType)} ${String(run.entityId ?? "(unknown id)")}.`
  return `The event "${event}" just happened in this workspace.${entity}\nEvent payload:\n${payload}\n\nCarry out your instructions for this event.`
}

/** Does this agent care about this event? Trigger + optional entity filter. */
export function matchesAiAgentTrigger(agent: AiAgent, event: AiAgentTriggerEnvelope): boolean {
  if (String(agent.status) !== "enabled") return false
  if (String(agent.triggerType) !== "event") return false
  if (stringOrNull(agent.triggerEvent) !== event.event) return false
  const entityType = stringOrNull(agent.triggerEntityType)
  if (entityType !== null && entityType !== (event.entityType ?? null)) return false
  return true
}

/** The tool names a stored definition enables. Anything else is ignored. */
export function aiAgentToolNames(agent: AiAgent): string[] {
  const raw = agent.tools
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is string => typeof value === "string" && value !== "")
}

/* -------------------------------- service --------------------------------- */

export function createAiAgentService(deps: AiAgentServiceDeps) {
  const events = deps.events ?? getEventBus()
  const now = deps.now ?? (() => new Date())
  const newId = deps.newId ?? (() => crypto.randomUUID())

  /* ------------------------------ authoring ------------------------------ */

  /** Every tool a definition names must exist, or the definition is a lie. */
  function assertKnownTools(names: readonly string[]): readonly string[] {
    const available = deps.tools.names()
    const unknown = names.filter((name) => !available.includes(name))
    if (unknown.length > 0) throw new AiAgentUnknownToolError(unknown, available)
    return names
  }

  async function list(
    ctx: AiAgentServiceContext,
    rawQuery: unknown,
  ): Promise<AiAgentListResult> {
    requirePermission(aiAgentPermission(ctx, "read"))
    const query = aiAgentQuerySchema.parse(rawQuery ?? {})
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(ctx: AiAgentServiceContext, id: string): Promise<AiAgentWithRuns> {
    requirePermission(aiAgentPermission(ctx, "read"))
    const agent = await loadAgent(ctx.workspaceId, id)
    const runs = await deps.store.listRuns(ctx.workspaceId, { agentId: id, limit: 20 })
    return { agent, runs: runs.data }
  }

  async function create(ctx: AiAgentServiceContext, rawInput: unknown): Promise<AiAgent> {
    requirePermission(aiAgentPermission(ctx, "create"))
    const input = createAiAgentSchema.parse(rawInput)
    assertKnownTools(input.tools)
    const ownerId =
      input.ownerId == null || input.ownerId === ctx.actorId
        ? ctx.actorId
        : assertMayAssignAiAgentOwner(ctx, input.ownerId)
    const agent = await deps.store.create(
      ctx.workspaceId,
      {
        ...input,
        ownerId,
        // Always born off. Turning an agent on is its own decision, and
        // its own permission (`run_ai`).
        status: "disabled",
        maxSteps: clampAiAgentBudget(
          input.maxSteps,
          AI_AGENT_DEFAULT_MAX_STEPS,
          AI_AGENT_MAX_STEPS_CEILING,
        ),
        maxToolCalls: clampAiAgentBudget(
          input.maxToolCalls,
          AI_AGENT_DEFAULT_MAX_TOOL_CALLS,
          AI_AGENT_MAX_TOOL_CALLS_CEILING,
        ),
        maxTotalTokens: clampAiAgentBudget(
          input.maxTotalTokens,
          AI_AGENT_DEFAULT_MAX_TOTAL_TOKENS,
          AI_AGENT_MAX_TOTAL_TOKENS_CEILING,
        ),
      },
      ctx.actorId,
    )
    await writeAgentAudit(ctx, "create", agent, { after: agent })
    return agent
  }

  async function update(
    ctx: AiAgentServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<AiAgent> {
    requirePermission(aiAgentPermission(ctx, "update"))
    const patch = updateAiAgentSchema.parse(rawPatch)
    const before = await loadAgent(ctx.workspaceId, id)
    if (patch.tools !== undefined) assertKnownTools(patch.tools)
    const ownerId =
      patch.ownerId == null || patch.ownerId === ctx.actorId
        ? patch.ownerId
        : assertMayAssignAiAgentOwner(ctx, patch.ownerId)
    // `status` is deliberately NOT patchable here — see `setStatus`.
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      {
        ...patch,
        ...(ownerId == null ? {} : { ownerId }),
        ...(patch.maxSteps == null
          ? {}
          : {
              maxSteps: clampAiAgentBudget(
                patch.maxSteps,
                AI_AGENT_DEFAULT_MAX_STEPS,
                AI_AGENT_MAX_STEPS_CEILING,
              ),
            }),
        ...(patch.maxToolCalls == null
          ? {}
          : {
              maxToolCalls: clampAiAgentBudget(
                patch.maxToolCalls,
                AI_AGENT_DEFAULT_MAX_TOOL_CALLS,
                AI_AGENT_MAX_TOOL_CALLS_CEILING,
              ),
            }),
        ...(patch.maxTotalTokens == null
          ? {}
          : {
              maxTotalTokens: clampAiAgentBudget(
                patch.maxTotalTokens,
                AI_AGENT_DEFAULT_MAX_TOTAL_TOKENS,
                AI_AGENT_MAX_TOTAL_TOKENS_CEILING,
              ),
            }),
      },
      ctx.actorId,
    )
    if (!after) throw new AiAgentNotFoundError(id)
    await writeAgentAudit(ctx, "update", after, { before, after })
    return after
  }

  /**
   * Turn an agent on or off. `run_ai` because this is the moment a model
   * starts acting on the workspace's behalf — authoring a disabled
   * definition is just writing a document.
   */
  async function setStatus(
    ctx: AiAgentServiceContext,
    id: string,
    rawInput: unknown,
  ): Promise<AiAgent> {
    requirePermission(aiAgentPermission(ctx, "run_ai"))
    const input = setAiAgentStatusSchema.parse(rawInput)
    const before = await loadAgent(ctx.workspaceId, id)
    if (input.status === "enabled" && stringOrNull(before.ownerId) === null) {
      throw new AiAgentStateError("an agent needs an owner to run as before it can be enabled")
    }
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      { status: input.status },
      ctx.actorId,
    )
    if (!after) throw new AiAgentNotFoundError(id)
    await writeAgentAudit(ctx, input.status === "enabled" ? "enable" : "disable", after, {
      before: { status: before.status },
      after: { status: after.status },
    })
    return after
  }

  async function remove(ctx: AiAgentServiceContext, id: string): Promise<AiAgent> {
    requirePermission(aiAgentPermission(ctx, "delete"))
    const before = await loadAgent(ctx.workspaceId, id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await writeAgentAudit(ctx, "delete", before, { before })
    return before
  }

  async function listRuns(
    ctx: AiAgentServiceContext,
    rawQuery: unknown,
  ): Promise<AiAgentRunListResult> {
    requirePermission(aiAgentPermission(ctx, "read", AI_AGENT_RUN_OBJECT))
    const query = aiAgentRunQuerySchema.parse(rawQuery ?? {})
    return deps.store.listRuns(ctx.workspaceId, query)
  }

  async function getRun(ctx: AiAgentServiceContext, id: string): Promise<AiAgentRun> {
    requirePermission(aiAgentPermission(ctx, "read", AI_AGENT_RUN_OBJECT))
    const run = await deps.store.findRunById(ctx.workspaceId, id)
    if (!run) throw new AiAgentRunNotFoundError(id)
    return run
  }

  async function loadAgent(workspaceId: string, id: string): Promise<AiAgent> {
    const found = await deps.store.findById(workspaceId, id)
    if (!found) throw new AiAgentNotFoundError(id)
    return found
  }

  async function writeAgentAudit(
    ctx: AiAgentServiceContext,
    action: string,
    agent: AiAgent,
    payload: { before?: unknown; after?: unknown },
  ): Promise<void> {
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action,
      object: AI_AGENT_OBJECT,
      recordId: agent.id,
      ...(payload.before === undefined ? {} : { before: payload.before }),
      ...(payload.after === undefined ? {} : { after: payload.after }),
      correlationId: ctx.correlationId ?? null,
      // Authoring is a human act; the RUN is what carries `source: "ai"`.
      source: "user",
    })
  }

  /* ------------------------------- dispatch ------------------------------- */

  /**
   * Entry point from the event bus. Finds the enabled agents listening to
   * this event, records one run per match (idempotently) and queues the
   * runnable ones.
   *
   * Not a user-callable method: it carries no caller context because there
   * is no caller — the *event's* actor caused it, and the run executes as
   * the agent's owner, whose live role is checked in `executeRun`.
   */
  async function dispatch(event: AiAgentTriggerEnvelope): Promise<AiAgentDispatchResult> {
    const { depth, parentRunId } = await resolveCascade(event)
    const candidates = await deps.store.listEnabledByTrigger(event.workspaceId, event.event)
    const matched = candidates.filter((agent) => matchesAiAgentTrigger(agent, event))
    const decisions: AiAgentDispatchDecision[] = []

    for (const agent of matched) {
      // LOOP PROTECTION: past the ceiling the run is recorded (so an
      // operator can see why the cascade stopped) but never enqueued, so
      // it spends no tokens and emits nothing.
      const tooDeep = depth > AI_AGENT_MAX_CASCADE_DEPTH
      const { run, created } = await deps.store.createRun(event.workspaceId, {
        agentId: agent.id,
        triggerType: "event",
        triggerEvent: event.event,
        triggerEventId: event.eventId,
        triggerPayload: event,
        entityType: event.entityType ?? null,
        entityId: event.entityId ?? null,
        actorId: stringOrNull(agent.ownerId),
        status: tooDeep ? "skipped" : "queued",
        depth,
        parentRunId,
        correlationId: event.correlationId ?? null,
        error: tooDeep
          ? `cascade depth ${String(depth)} exceeds the maximum of ${String(AI_AGENT_MAX_CASCADE_DEPTH)}`
          : null,
      })

      // IDEMPOTENCY: this exact event already produced this run. Do not
      // enqueue it again — the agent has run, or is running.
      if (!created) {
        decisions.push({ agentId: agent.id, runId: run.id, outcome: "duplicate" })
        continue
      }
      if (tooDeep) {
        decisions.push({ agentId: agent.id, runId: run.id, outcome: "queue_failed" })
        continue
      }
      try {
        await deps.queue.enqueueAiAgentRun({
          workspaceId: event.workspaceId,
          agentId: agent.id,
          runId: run.id,
          triggerEventId: event.eventId,
          ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
        })
      } catch (err) {
        // The run row already exists and, being keyed on the event id, a
        // redelivery would be treated as a duplicate and never enqueued.
        // So a failed enqueue has to be visible rather than silent.
        await deps.store.updateRun(event.workspaceId, run.id, {
          status: "failed",
          error: `could not queue the run: ${errorMessageOf(err)}`,
          finishedAt: now(),
        })
        decisions.push({ agentId: agent.id, runId: run.id, outcome: "queue_failed" })
        continue
      }
      decisions.push({ agentId: agent.id, runId: run.id, outcome: "queued" })
    }

    return { event: event.event, eventId: event.eventId, matched: matched.length, decisions }
  }

  /** Depth of the run this event would create, from the run that caused it. */
  async function resolveCascade(
    event: AiAgentTriggerEnvelope,
  ): Promise<{ depth: number; parentRunId: string | null }> {
    const parentRunId = parseAiAgentRunCorrelationId(event.correlationId)
    if (parentRunId === null) return { depth: 0, parentRunId: null }
    const parent = await deps.store.findRunById(event.workspaceId, parentRunId)
    if (!parent) return { depth: 1, parentRunId: null }
    return { depth: numberOr(parent.depth, 0) + 1, parentRunId: parent.id }
  }

  /**
   * Manual run (spec 36 §3). Records a run and queues it on the same path
   * an event takes — a hand-started run is the production path, with the
   * same permissions, the same budgets and the same queue.
   *
   * `run_ai` here, unlike execution: pressing Run is a person choosing to
   * spend tokens and to let a model act. The run itself still executes as
   * the agent's OWNER, never as the person who pressed the button, so a
   * member cannot borrow an admin-owned agent's reach... and an admin
   * cannot lend it by pressing Run either.
   */
  async function runNow(
    ctx: AiAgentServiceContext,
    id: string,
    rawInput: unknown,
  ): Promise<AiAgentRun> {
    requirePermission(aiAgentPermission(ctx, "run_ai"))
    const input = runAiAgentSchema.parse(rawInput ?? {})
    const agent = await loadAgent(ctx.workspaceId, id)
    const triggerEventId = `manual:${newId()}`
    const { run } = await deps.store.createRun(ctx.workspaceId, {
      agentId: agent.id,
      triggerType: "manual",
      triggerEvent: null,
      triggerEventId,
      triggerPayload: input.sample ?? null,
      input: input.input ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      actorId: stringOrNull(agent.ownerId),
      status: "queued",
      depth: 0,
      parentRunId: null,
      correlationId: ctx.correlationId ?? null,
    })
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "run",
      object: AI_AGENT_OBJECT,
      recordId: agent.id,
      after: { runId: run.id, triggerEventId, manual: true, startedBy: ctx.actorId },
      correlationId: ctx.correlationId ?? null,
      source: "user",
    })
    try {
      await deps.queue.enqueueAiAgentRun({
        workspaceId: ctx.workspaceId,
        agentId: agent.id,
        runId: run.id,
        triggerEventId,
        ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
      })
    } catch (err) {
      const failed = await deps.store.updateRun(ctx.workspaceId, run.id, {
        status: "failed",
        error: `could not queue the run: ${errorMessageOf(err)}`,
        finishedAt: now(),
      })
      return failed ?? run
    }
    return run
  }

  /* ------------------------------ execution ------------------------------- */

  /**
   * Run one tool under the OWNER's context, never throwing outward: a
   * refused or broken tool is information the model must see and the run
   * must record, not a crash.
   */
  async function runTool(
    toolCtx: AiAgentToolContext,
    call: AiToolCall,
    allowed: ReadonlySet<string>,
  ): Promise<{ report: AiAgentToolCallReport; content: string }> {
    const startedAt = Date.now()
    const tool = allowed.has(call.name) ? deps.tools.get(call.name) : null
    let outcome: AiAgentToolCallReport["outcome"] = "succeeded"
    let summary: string
    let content: string
    let requestId: string | null = null

    if (!tool) {
      // Either the model invented a tool, or it named one this agent is
      // not scoped to. Both are the same answer: it does not exist here.
      outcome = "blocked"
      summary = `Tool ${call.name} is not available to this agent`
      content = serialiseToolResult({ error: "tool_not_available", message: summary })
    } else {
      try {
        const execution = await tool.execute(toolCtx, call.arguments)
        summary = execution.summary
        content = serialiseToolResult(execution.result)
        const result = execution.result
        if (typeof result === "object" && result !== null && "requestId" in result) {
          requestId = stringOrNull((result as { requestId?: unknown }).requestId)
        }
      } catch (err) {
        const denied = err instanceof PermissionDeniedError
        outcome = denied ? "denied" : "failed"
        const message = errorMessageOf(err)
        summary = denied ? `Permission denied for ${call.name}` : `${call.name} failed: ${message}`
        content = serialiseToolResult({
          error: denied ? "permission_denied" : errorCodeOf(err),
          message,
        })
      }
    }

    const report: AiAgentToolCallReport = {
      id: call.id,
      name: call.name,
      access: tool?.access ?? "read",
      arguments: call.arguments,
      outcome,
      summary,
      durationMs: Date.now() - startedAt,
      requestId,
    }

    // ATTRIBUTION: every tool call names its agent, its run and its model.
    await events.emit(
      createEvent({
        event: AiEvents.ToolCalled,
        workspaceId: toolCtx.workspaceId,
        actorId: toolCtx.actorId,
        actorType: "ai",
        entityType: AI_AGENT_TOOL_OBJECT,
        entityId: toolCtx.runId,
        after: {
          agentId: toolCtx.agentId,
          runId: toolCtx.runId,
          model: toolCtx.model,
          tool: call.name,
          access: report.access,
          outcome,
          durationMs: report.durationMs,
          requestId,
        },
        correlationId: aiAgentRunCorrelationId(toolCtx.runId),
      }),
    )
    await deps.audit({
      workspaceId: toolCtx.workspaceId,
      actorId: toolCtx.actorId,
      action: `tool.${call.name}`,
      object: AI_AGENT_TOOL_OBJECT,
      recordId: toolCtx.runId,
      after: {
        agentId: toolCtx.agentId,
        runId: toolCtx.runId,
        model: toolCtx.model,
        providerId: deps.provider.id,
        tool: call.name,
        access: report.access,
        arguments: call.arguments,
        outcome,
        durationMs: report.durationMs,
        requestId,
      },
      correlationId: aiAgentRunCorrelationId(toolCtx.runId),
      source: "ai",
    })
    return { report, content }
  }

  /**
   * Execute one queued run. Called by the worker job through the queue
   * seam, never from a request handler.
   *
   * No caller context: the run already names the actor it inherits from,
   * and taking one would be the escalation hole this design exists to
   * close.
   */
  async function executeRun(workspaceId: string, runId: string): Promise<AiAgentRunOutcome> {
    const run = await deps.store.findRunById(workspaceId, runId)
    if (!run) throw new AiAgentRunNotFoundError(runId)

    // IDEMPOTENCY, second line: the job was redelivered after the run
    // already finished. Never spend a second set of tokens on it.
    if (isTerminal(run.status)) {
      return {
        runId,
        status: String(run.status),
        steps: numberOr(run.steps, 0),
        toolCalls: [],
        proposalCount: numberOr(run.proposalCount, 0),
        totalTokens: numberOr(run.totalTokens, 0),
        latencyMs: numberOr(run.latencyMs, 0),
        costMicros: typeof run.costMicros === "number" ? run.costMicros : null,
        summary: stringOrNull(run.summary) ?? "",
      }
    }

    const agent = await deps.store.findById(workspaceId, run.agentId)
    if (!agent) {
      return finishRun(run, {
        status: "failed",
        error: `ai agent ${run.agentId} no longer exists`,
        errorCode: "NOT_FOUND",
      })
    }

    // PERMISSION INHERITANCE: resolve the OWNER's role NOW, not when the
    // agent was written, and refuse to run at all if they have left.
    const ownerId = stringOrNull(agent.ownerId) ?? stringOrNull(agent.createdBy) ?? ""
    let ownerRole: string
    try {
      const resolved = ownerId === "" ? null : await deps.resolveActorRole(workspaceId, ownerId)
      assertAiAgentActorResolved(workspaceId, ownerId, resolved)
      ownerRole = resolved
      assertAiAgentRunAllowed({ workspaceId, actorId: ownerId, role: ownerRole })
    } catch (err) {
      return finishRun(run, {
        status: "denied",
        error: errorMessageOf(err),
        errorCode: errorCodeOf(err),
        actorRole: null,
      })
    }

    // BOUNDED LOOPS: the stored budgets are clamped against the ceilings
    // again, here, so a hand-edited row cannot buy an unbounded loop.
    const maxSteps = clampAiAgentBudget(
      typeof agent.maxSteps === "number" ? agent.maxSteps : null,
      AI_AGENT_DEFAULT_MAX_STEPS,
      AI_AGENT_MAX_STEPS_CEILING,
    )
    const maxToolCalls = clampAiAgentBudget(
      typeof agent.maxToolCalls === "number" ? agent.maxToolCalls : null,
      AI_AGENT_DEFAULT_MAX_TOOL_CALLS,
      AI_AGENT_MAX_TOOL_CALLS_CEILING,
    )
    const maxTotalTokens = clampAiAgentBudget(
      typeof agent.maxTotalTokens === "number" ? agent.maxTotalTokens : null,
      AI_AGENT_DEFAULT_MAX_TOTAL_TOKENS,
      AI_AGENT_MAX_TOTAL_TOKENS_CEILING,
    )

    const startedRun =
      (await deps.store.updateRun(workspaceId, run.id, {
        status: "running",
        startedAt: now(),
        actorRole: ownerRole,
      })) ?? run

    const toolNames = aiAgentToolNames(agent)
    const tools = deps.tools.subset(toolNames)
    const allowed = new Set(tools.map((tool) => tool.name))
    const definitions = deps.tools.definitions(toolNames)
    const requestedModel = stringOrNull(agent.model)
    const toolCtx: AiAgentToolContext = {
      workspaceId,
      actorId: ownerId,
      role: ownerRole,
      correlationId: aiAgentRunCorrelationId(run.id),
      agentId: String(agent.id),
      runId: String(run.id),
      model: requestedModel ?? deps.provider.defaultModel,
    }

    const working: AiMessage[] = [
      {
        role: "system",
        content: buildAiAgentSystemPrompt({
          now: now(),
          name: String(agent.name),
          instructions: String(agent.instructions),
          toolNames: tools.map((tool) => tool.name),
          canPropose: tools.some((tool) => tool.access === "propose"),
        }),
      },
      { role: "user", content: buildAiAgentTaskMessage(startedRun) },
    ]

    const usageParts: AiUsage[] = []
    const toolReports: AiAgentToolCallReport[] = []
    let latencyMs = 0
    let steps = 0
    let toolCallCount = 0
    let summary = ""
    let providerId = deps.provider.id
    let model = toolCtx.model
    /** Default `exhausted`: only a finished answer earns `succeeded`. */
    let status: "succeeded" | "exhausted" | "failed" = "exhausted"
    let errorCode: string | null = "AI_AGENT_BUDGET_EXHAUSTED"
    let error: string | null = null

    try {
      for (let step = 0; step < maxSteps; step += 1) {
        const completion = await deps.provider.completeWithTools(working, definitions, {
          ...(requestedModel === null ? {} : { model: requestedModel }),
          correlationId: toolCtx.correlationId,
        })
        steps += 1
        usageParts.push(completion.usage)
        latencyMs += completion.latencyMs
        providerId = completion.providerId
        model = completion.model
        toolCtx.model = completion.model

        if (completion.toolCalls.length === 0) {
          summary = completion.text
          status = "succeeded"
          errorCode = null
          break
        }

        working.push({
          role: "assistant",
          content: completion.text,
          toolCalls: completion.toolCalls,
        })
        if (completion.text !== "") summary = completion.text

        let budgetHit = false
        for (const call of completion.toolCalls) {
          if (toolCallCount >= maxToolCalls) {
            budgetHit = true
            working.push({
              role: "tool",
              content: serialiseToolResult({
                error: "tool_budget_exhausted",
                message: `this run may make at most ${String(maxToolCalls)} tool calls`,
              }),
              toolCallId: call.id,
              name: call.name,
            })
            continue
          }
          toolCallCount += 1
          const { report, content } = await runTool(toolCtx, call, allowed)
          toolReports.push(report)
          working.push({ role: "tool", content, toolCallId: call.id, name: call.name })
        }

        if (budgetHit) {
          error = `stopped after ${String(toolCallCount)} tool calls: the tool-call budget is spent`
          break
        }
        if (sumAiUsage(usageParts).totalTokens >= maxTotalTokens) {
          error = `stopped after ${String(steps)} steps: the token budget of ${String(maxTotalTokens)} is spent`
          break
        }
      }
      if (status === "exhausted" && error === null) {
        error = `stopped after ${String(steps)} steps: the step budget is spent`
      }
    } catch (err) {
      status = "failed"
      errorCode = errorCodeOf(err)
      error = errorMessageOf(err)
    }

    const usage = sumAiUsage(usageParts)
    return finishRun(startedRun, {
      status,
      ...(error === null ? {} : { error }),
      ...(errorCode === null ? {} : { errorCode }),
      actorRole: ownerRole,
      steps,
      toolCalls: toolReports,
      usage,
      latencyMs,
      providerId,
      model,
      summary: truncate(summary, SUMMARY_MAX_CHARS),
      markRan: true,
    })
  }

  /**
   * Close a run: persist the accounting, audit it and emit the completion
   * event. Every exit from `executeRun` goes through here, so there is no
   * path that spends tokens without recording what they bought.
   */
  async function finishRun(
    run: AiAgentRun,
    input: {
      status: string
      error?: string
      errorCode?: string
      actorRole?: string | null
      steps?: number
      toolCalls?: AiAgentToolCallReport[]
      usage?: AiUsage
      latencyMs?: number
      providerId?: string
      model?: string
      summary?: string
      markRan?: boolean
    },
  ): Promise<AiAgentRunOutcome> {
    const usage = input.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    const toolCalls = input.toolCalls ?? []
    const proposals = toolCalls.filter((report) => report.access === "propose")
    const proposalCount = proposals.filter((report) => report.requestId != null).length
    const model = input.model ?? deps.provider.defaultModel
    const costMicros = computeAiCostMicros(deps.pricing, model, usage)
    const finishedAt = now()

    const patch = {
      status: input.status,
      steps: input.steps ?? 0,
      toolCallCount: toolCalls.length,
      proposalCount,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      latencyMs: input.latencyMs ?? 0,
      costMicros,
      providerId: input.providerId ?? deps.provider.id,
      model,
      summary: input.summary ?? null,
      // Per-call trace: names, outcomes, durations and the proposal ids.
      // No payloads, no tool results, no secrets.
      stepLog: toolCalls.map((report) => ({
        name: report.name,
        access: report.access,
        outcome: report.outcome,
        durationMs: report.durationMs,
        requestId: report.requestId ?? null,
      })),
      error: input.error ?? null,
      errorCode: input.errorCode ?? null,
      ...(input.actorRole === undefined ? {} : { actorRole: input.actorRole }),
      finishedAt,
    }
    const finished = (await deps.store.updateRun(run.workspaceId, run.id, patch)) ?? {
      ...run,
      ...patch,
    }
    if (input.markRan === true) {
      await deps.store.markAgentRan(run.workspaceId, String(run.agentId), finishedAt)
    }

    const attribution = {
      agentId: finished.agentId,
      runId: finished.id,
      triggerType: finished.triggerType ?? null,
      triggerEvent: finished.triggerEvent ?? null,
      triggerEventId: finished.triggerEventId,
      actorId: stringOrNull(finished.actorId),
      actorRole: input.actorRole ?? null,
      // Read back from the stored row, so the trail records what was
      // persisted rather than what this function intended.
      status: String(finished.status),
      steps: patch.steps,
      toolCallCount: patch.toolCallCount,
      proposalCount,
      proposedRequestIds: proposals.map((report) => report.requestId).filter((id) => id != null),
      providerId: patch.providerId,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      latencyMs: patch.latencyMs,
      costMicros,
      errorCode: patch.errorCode,
    }

    await events.emit(
      createEvent({
        event: AiEvents.AgentCompleted,
        workspaceId: run.workspaceId,
        actorType: "ai",
        entityType: AI_AGENT_RUN_OBJECT,
        entityId: String(run.id),
        after: attribution,
        correlationId: aiAgentRunCorrelationId(String(run.id)),
        ...(stringOrNull(run.actorId) === null ? {} : { actorId: String(run.actorId) }),
      }),
    )
    await deps.audit({
      workspaceId: run.workspaceId,
      actorId: stringOrNull(run.actorId),
      action: "run",
      object: AI_AGENT_RUN_OBJECT,
      recordId: String(run.id),
      after: attribution,
      correlationId: aiAgentRunCorrelationId(String(run.id)),
      source: "ai",
    })

    return {
      runId: String(run.id),
      status: input.status,
      steps: patch.steps,
      toolCalls,
      proposalCount,
      totalTokens: usage.totalTokens,
      latencyMs: patch.latencyMs,
      costMicros,
      summary: input.summary ?? "",
      ...(input.error === undefined ? {} : { error: input.error }),
    }
  }

  return {
    create,
    dispatch,
    executeRun,
    get,
    getRun,
    list,
    listRuns,
    remove,
    runNow,
    setStatus,
    update,
  }
}

export type AiAgentService = ReturnType<typeof createAiAgentService>

/**
 * Subscribe the agent dispatcher to the in-process event bus.
 *
 * WIRING NOTE: the application bootstrap (`apps/api/src/index.ts`) owns
 * this call — route factories must not subscribe, because route
 * construction happens in tests that emit unrelated events on the shared
 * bus. `apps/api/src/routes/modules/ai-agents.ts` re-exports a bound
 * version so the bootstrap is one line.
 *
 * Returns the unsubscribe function.
 */
export function subscribeAiAgentDispatcher(
  bus: {
    on(event: string, handler: (event: AiAgentTriggerEnvelope) => Promise<void>): () => void
  },
  service: Pick<AiAgentService, "dispatch">,
  onError: (err: unknown, event: AiAgentTriggerEnvelope) => void = () => {},
): () => void {
  return bus.on("*", async (event: AiAgentTriggerEnvelope) => {
    // A failing agent must never fail the business write that triggered
    // it: the run row already records what happened.
    try {
      await service.dispatch(event)
    } catch (err) {
      onError(err, event)
    }
  })
}
