import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"
import { WORKFLOW_TRIGGER_EVENTS, isWorkflowTriggerEvent } from "../automation/schemas"

/**
 * AI agent zod schemas (spec 36-ai-agents, P0).
 *
 * Services validate inputs with these; API routes reuse them at the HTTP
 * boundary via `@hono/zod-validator`. The vocabulary here is the canonical
 * one for the domain layer and is mirrored — never widened — in
 * `@yourcrm/database`'s `schema/ai-agents.ts` and in the CHECK constraints
 * of migration `0400_ai_agents.sql`.
 *
 * Nothing here invents a second version of something the repo already has:
 * the triggerable-event allowlist is the automation engine's
 * (`WORKFLOW_TRIGGER_EVENTS`, itself derived from the `@yourcrm/events`
 * constants), because "which domain events may a non-human actor react to"
 * has exactly one answer in this product.
 */

/* -------------------------------- vocabulary ------------------------------ */

/** A definition is off until somebody with `run_ai` turns it on. */
export const AI_AGENT_STATUSES = ["disabled", "enabled"] as const

export type AiAgentStatus = (typeof AI_AGENT_STATUSES)[number]

export const aiAgentStatusSchema = z.enum(AI_AGENT_STATUSES)

/**
 * P0 triggers. `manual` is a person pressing Run; `event` is a domain
 * event from `@yourcrm/events`. A schedule trigger is the same shape plus
 * a repeatable job on the existing queue seam — deliberately P1.
 */
export const AI_AGENT_TRIGGER_TYPES = ["manual", "event"] as const

export type AiAgentTriggerType = (typeof AI_AGENT_TRIGGER_TYPES)[number]

export const aiAgentTriggerTypeSchema = z.enum(AI_AGENT_TRIGGER_TYPES)

/**
 * Run lifecycle.
 *
 * `exhausted` is its own terminal status, not a flavour of `failed`: a run
 * that hit a budget ceiling did legitimate work and must be visibly
 * distinguishable from one that broke, because the operator's response is
 * different (raise the budget vs. fix the agent). `denied` means the
 * owner's live role refused the run or a tool.
 */
export const AI_AGENT_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "exhausted",
  "denied",
  "skipped",
] as const

export type AiAgentRunStatus = (typeof AI_AGENT_RUN_STATUSES)[number]

export const aiAgentRunStatusSchema = z.enum(AI_AGENT_RUN_STATUSES)

/** Triggerable events: the automation engine's allowlist, reused as-is. */
export const AI_AGENT_TRIGGER_EVENTS: readonly string[] = WORKFLOW_TRIGGER_EVENTS

export function isAiAgentTriggerEvent(value: unknown): value is string {
  return isWorkflowTriggerEvent(value)
}

export const aiAgentTriggerEventSchema = z
  .string()
  .refine(isAiAgentTriggerEvent, { message: "unknown trigger event" })

/* --------------------------------- budgets -------------------------------- */

/**
 * THE CEILINGS. A definition may ask for less; it can never ask for more,
 * and `service.ts` clamps the stored value against these again at
 * execution time, so a hand-edited row cannot buy an unbounded loop.
 */
export const AI_AGENT_MAX_STEPS_CEILING = 12
export const AI_AGENT_MAX_TOOL_CALLS_CEILING = 24
export const AI_AGENT_MAX_TOTAL_TOKENS_CEILING = 200_000

export const AI_AGENT_DEFAULT_MAX_STEPS = 6
export const AI_AGENT_DEFAULT_MAX_TOOL_CALLS = 12
export const AI_AGENT_DEFAULT_MAX_TOTAL_TOKENS = 60_000

/** Clamp one budget into [1, ceiling]; `null`/absent takes the default. */
export function clampAiAgentBudget(
  value: number | null | undefined,
  fallback: number,
  ceiling: number,
): number {
  const raw = value == null || !Number.isFinite(value) ? fallback : Math.floor(value)
  if (raw < 1) return 1
  return raw > ceiling ? ceiling : raw
}

/* -------------------------------- definition ------------------------------ */

const nameSchema = z.string().trim().min(1).max(160)
const toolNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, "tool names are lower snake_case")
const entityTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, "entityType must be lower snake_case")

const agentShape = {
  name: nameSchema,
  description: z.string().trim().max(2000).nullish(),
  /** The system prompt. An agent with no instructions is not an agent. */
  instructions: z.string().trim().min(1).max(20_000),
  model: z.string().trim().min(1).max(128).nullish(),
  /** Allowlisted subset of the registry. Empty means "no tools at all". */
  tools: z.array(toolNameSchema).max(16).default([]),
  triggerType: aiAgentTriggerTypeSchema.default("manual"),
  triggerEvent: aiAgentTriggerEventSchema.nullish(),
  triggerEntityType: entityTypeSchema.nullish(),
  /** The person the agent runs as. Defaults to the author. */
  ownerId: z.string().trim().min(1).max(128).nullish(),
  maxSteps: z.number().int().min(1).max(AI_AGENT_MAX_STEPS_CEILING).nullish(),
  maxToolCalls: z.number().int().min(1).max(AI_AGENT_MAX_TOOL_CALLS_CEILING).nullish(),
  maxTotalTokens: z.number().int().min(1).max(AI_AGENT_MAX_TOTAL_TOKENS_CEILING).nullish(),
}

/** An event-triggered agent must say which event; a manual one must not. */
function refineTrigger(
  value: { triggerType?: string | undefined; triggerEvent?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.triggerType === undefined) return
  const hasEvent = value.triggerEvent != null && value.triggerEvent !== ""
  if (value.triggerType === "event" && !hasEvent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["triggerEvent"],
      message: "an event-triggered agent must name the event it listens to",
    })
  }
  if (value.triggerType === "manual" && hasEvent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["triggerEvent"],
      message: "a manual agent does not listen to an event",
    })
  }
}

export const createAiAgentSchema = z.object(agentShape).superRefine(refineTrigger)

export type CreateAiAgentInput = z.infer<typeof createAiAgentSchema>

export const updateAiAgentSchema = z
  .object({ ...agentShape, tools: z.array(toolNameSchema).max(16) })
  .partial()
  .superRefine(refineTrigger)
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateAiAgentInput = z.infer<typeof updateAiAgentSchema>

export const setAiAgentStatusSchema = z.object({ status: aiAgentStatusSchema })

export type SetAiAgentStatusInput = z.infer<typeof setAiAgentStatusSchema>

export const aiAgentQuerySchema = paginationQuerySchema.extend({
  status: aiAgentStatusSchema.optional(),
  triggerType: aiAgentTriggerTypeSchema.optional(),
  triggerEvent: z.string().trim().min(1).max(128).optional(),
  query: z.string().trim().min(1).max(200).optional(),
})

export type AiAgentQuery = z.infer<typeof aiAgentQuerySchema>

/* ----------------------------------- runs --------------------------------- */

/** Manual run. `input` is the task for this one execution, not the prompt. */
export const runAiAgentSchema = z.object({
  input: z.string().trim().min(1).max(4000).nullish(),
  entityType: entityTypeSchema.nullish(),
  entityId: z.string().trim().min(1).max(128).nullish(),
  sample: z.record(z.unknown()).nullish(),
})

export type RunAiAgentInput = z.infer<typeof runAiAgentSchema>

export const aiAgentRunQuerySchema = paginationQuerySchema.extend({
  agentId: z.string().trim().min(1).max(128).optional(),
  status: aiAgentRunStatusSchema.optional(),
})

export type AiAgentRunQuery = z.infer<typeof aiAgentRunQuerySchema>

/* -------------------------------- responses ------------------------------- */

export const aiAgentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  instructions: z.string(),
  model: z.string().nullable().optional(),
  tools: z.unknown().optional(),
  triggerType: z.string(),
  triggerEvent: z.string().nullable().optional(),
  triggerEntityType: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  status: z.string(),
  maxSteps: z.number().optional(),
  maxToolCalls: z.number().optional(),
  maxTotalTokens: z.number().optional(),
  lastRunAt: z.union([z.string(), z.date()]).nullable().optional(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
})

export const aiAgentRunSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  triggerType: z.string(),
  triggerEvent: z.string().nullable().optional(),
  triggerEventId: z.string(),
  entityType: z.string().nullable().optional(),
  entityId: z.string().nullable().optional(),
  actorId: z.string().nullable().optional(),
  actorRole: z.string().nullable().optional(),
  status: z.string(),
  steps: z.number().optional(),
  toolCallCount: z.number().optional(),
  proposalCount: z.number().optional(),
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  latencyMs: z.number().optional(),
  costMicros: z.number().nullable().optional(),
  providerId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  stepLog: z.unknown().optional(),
  errorCode: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  correlationId: z.string().nullable().optional(),
  startedAt: z.union([z.string(), z.date()]).nullable().optional(),
  finishedAt: z.union([z.string(), z.date()]).nullable().optional(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
})

export type AiAgentDto = z.infer<typeof aiAgentSchema>
export type AiAgentRunDto = z.infer<typeof aiAgentRunSchema>

/* ------------------------------ proposal tool ----------------------------- */

/**
 * Arguments of the `crm_propose_change` tool.
 *
 * Deliberately a SHAPE gate only. The authoritative validation is
 * `createAiActionRequestSchema` in `../ai-governance`, which the proposal
 * port runs for every caller — this parse exists so a malformed tool call
 * comes back to the model as a readable tool error instead of an
 * exception, and so the agent module never has to restate the governance
 * rules (a create must not name a record, an update must carry before and
 * after, a rationale is mandatory, …).
 */
export const aiAgentProposeToolArgsSchema = z.object({
  objectType: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{0,63}$/, "objectType must be lower snake_case"),
  recordId: z.string().trim().min(1).max(128).nullish(),
  action: z.enum(["create", "update", "delete", "send_external"]),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  rationale: z.string().trim().min(1).max(4000),
})

export type AiAgentProposeToolArgs = z.infer<typeof aiAgentProposeToolArgsSchema>

/* ----------------------------- loop protection ---------------------------- */

/**
 * How far an agent-caused cascade may travel.
 *
 * An agent's proposal, once a human approves it, is applied through the
 * owning module's domain service and emits that module's ordinary event —
 * carrying the run's correlation id (`agentrun:<runId>`). That event can
 * trigger an event-driven agent, whose proposal can be approved, and so
 * on. Every hop needs a human, so this is a slow loop rather than a hot
 * one, but a loop is a loop: `dispatch` derives each run's depth from the
 * run named by the triggering event's correlation id and records anything
 * past this ceiling as `skipped` without enqueuing it.
 *
 * Same mechanism and the same reasoning as `WORKFLOW_MAX_CASCADE_DEPTH`
 * (a non-human actor's cascade is one problem with one answer), but a
 * lower ceiling: every hop here spends real tokens and real human
 * attention.
 */
export const AI_AGENT_MAX_CASCADE_DEPTH = 3
