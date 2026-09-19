import { z } from "zod"
import { AiEvents } from "@yourcrm/events"

/**
 * AI agent run job (spec 36-ai-agents, P0).
 *
 * The worker half of the queue seam. Everything that makes an agent safe —
 * the bounded loop, the owner's live permissions, the read-only tools, the
 * approval queue every proposed write goes through, the accounting — lives
 * in `@yourcrm/crm/src/ai-agents`. This file only makes the loop run on a
 * worker instead of in the request path, because an LLM loop with a token
 * budget has no business occupying an HTTP connection.
 *
 * Like `automation.ts`, the payload schema is restated here rather than
 * imported: this file is the process boundary, and spec 01 requires a job
 * to be a pure function of ITS OWN validated input.
 *
 * WHY THE RUNNER IS INJECTED
 * --------------------------
 * The domain service needs a provider, the assistant's tool registry, the
 * governance port, a store and an audit sink — a composition root, which
 * belongs to the app bootstrap, not to a job handler. The bootstrap binds
 * it once:
 *
 * ```ts
 * registerAiAgentRunner(async (payload) =>
 *   aiAgentService.executeRun(payload.workspaceId, payload.runId),
 * )
 * ```
 *
 * Until that call is made the default runner fails loudly, so a
 * misconfigured deployment dead-letters visibly instead of silently
 * dropping agent runs.
 *
 * THE PROPERTIES ARE NOT RE-IMPLEMENTED HERE — and the transport cannot
 * weaken them either:
 *  - NO UNAPPROVED WRITES: this handler has no CRM access of any kind. The
 *    only thing it can do is name a run that already exists.
 *  - IDEMPOTENCY: the enqueue uses a deterministic job id derived from the
 *    triggering event, and `executeRun` is a no-op on a run that already
 *    reached a terminal status. Retrying this job is safe by construction,
 *    which for an LLM agent also means it cannot spend the tokens twice.
 *  - PERMISSION INHERITANCE: the payload carries no actor and no role. The
 *    runner resolves the agent owner's live role; there is nothing here a
 *    caller could spoof.
 *  - BOUNDED LOOPS: the budgets live on the definition and are clamped
 *    against their ceilings inside the service, so a hand-crafted payload
 *    cannot buy extra steps — there is no budget field to craft.
 */

export const AI_AGENT_RUN_JOB_NAME = "ai.agent.run"

export const aiAgentRunJobPayloadSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  /** Envelope id of the triggering event, or `manual:<uuid>`. */
  triggerEventId: z.string().min(1).max(128),
  correlationId: z.string().max(128).optional(),
})

export type AiAgentRunJobPayload = z.infer<typeof aiAgentRunJobPayloadSchema>

export type AiAgentRunResult = {
  runId: string
  status: string
  steps: number
  proposalCount: number
  totalTokens: number
  latencyMs: number
  costMicros: number | null
}

/** Deterministic job id: one job per (agent, triggering event), forever. */
export function aiAgentRunJobId(payload: {
  workspaceId: string
  agentId: string
  triggerEventId: string
}): string {
  return `${AI_AGENT_RUN_JOB_NAME}:${payload.workspaceId}:${payload.agentId}:${payload.triggerEventId}`
}

/** What the bootstrap binds: usually `service.executeRun`. */
export type AiAgentRunnerPort = (payload: AiAgentRunJobPayload) => Promise<AiAgentRunResult>

export class AiAgentRunnerNotBoundError extends Error {
  readonly code = "AI_AGENT_RUNNER_NOT_BOUND"
  constructor() {
    super(
      "no AI agent runner is registered: call registerAiAgentRunner() from the worker bootstrap",
    )
    this.name = "AiAgentRunnerNotBoundError"
  }
}

const unboundRunner: AiAgentRunnerPort = async () => {
  throw new AiAgentRunnerNotBoundError()
}

let runner: AiAgentRunnerPort = unboundRunner

export function registerAiAgentRunner(next: AiAgentRunnerPort): void {
  runner = next
}

/** Restores the unbound default (tests, and a clean shutdown). */
export function resetAiAgentRunner(): void {
  runner = unboundRunner
}

/**
 * Execute one queued agent run. Retryable (the runner is idempotent),
 * observable (a JSON line carrying the run id, the outcome and the spend)
 * and validated at run time as well as at enqueue.
 */
export async function runAiAgentJob(input: unknown): Promise<AiAgentRunResult> {
  const payload = aiAgentRunJobPayloadSchema.parse(input)
  const start = Date.now()
  const result = await runner(payload)
  console.log(
    JSON.stringify({
      level: "info",
      msg: "ai_agent_run_executed",
      // The run emits AiEvents.{ToolCalled,AgentCompleted} from the domain
      // service; this line is the transport's own trace.
      event: AiEvents.AgentCompleted,
      workspaceId: payload.workspaceId,
      agentId: payload.agentId,
      runId: payload.runId,
      triggerEventId: payload.triggerEventId,
      status: result.status,
      steps: result.steps,
      // Proposals, never applied changes: an agent cannot write.
      proposalCount: result.proposalCount,
      totalTokens: result.totalTokens,
      costMicros: result.costMicros,
      providerLatencyMs: result.latencyMs,
      durationMs: Date.now() - start,
      ...(payload.correlationId === undefined ? {} : { correlationId: payload.correlationId }),
    }),
  )
  return result
}
