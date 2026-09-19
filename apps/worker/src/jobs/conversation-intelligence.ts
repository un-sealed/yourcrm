import { z } from "zod"

/**
 * Conversation-analysis job (spec 37-ai-conversation-intelligence, P0).
 *
 * The worker half of the queue seam. Analysis is on-demand or queued and
 * NEVER inline in a request: the API validates, checks permissions,
 * persists a `queued` row and enqueues this payload; here it runs on a
 * worker, where a slow provider costs a background job rather than an
 * HTTP timeout.
 *
 * Like `automation.ts` and `import-export.ts`, the payload schema is
 * restated here rather than imported: this file is the process boundary,
 * and spec 01 requires a job to be a pure function of ITS OWN validated
 * input. The canonical contract is `ConversationAnalysisJob` in
 * `@yourcrm/crm/src/conversation-intelligence/types.ts`; keep the two in
 * step.
 *
 * WHY THE RUNNER IS INJECTED
 * --------------------------
 * The domain service needs a provider, a store and every conversation
 * source — that is composition-root work, and the composition root is
 * `apps/api`. So this file takes a port that the worker bootstrap binds
 * once:
 *
 * ```ts
 * registerConversationAnalysisRunner(async (payload) =>
 *   conversationIntelligence.runQueuedConversationAnalysis(
 *     { workspaceId: payload.workspaceId, actorId: payload.actorId, role, correlationId },
 *     payload.analysisId,
 *   ),
 * )
 * ```
 *
 * Until it is bound the default fails loudly, so a misconfigured
 * deployment dead-letters visibly instead of silently dropping analyses.
 *
 * THE FOUR PROPERTIES ARE NOT RE-IMPLEMENTED HERE — and the transport
 * cannot weaken them:
 *
 *  - **Permission inheritance.** The payload carries `actorId`, never a
 *    role and never a decision. `runQueuedConversationAnalysis` re-runs
 *    every gate, including re-resolving the conversation through its
 *    owning module. A job that outlives somebody's access to a thread
 *    does nothing.
 *  - **No silent writes.** The runner produces an analysis row. There is
 *    no code path from a job to a task; proposing one is an explicit
 *    human action in the API.
 *  - **Bounded cost.** The payload carries no text — the conversation is
 *    re-fetched and re-bounded by the domain service, so a hand-crafted
 *    payload cannot enlarge a request.
 *  - **PII stays put.** Nothing in this payload and nothing in the log
 *    line below is conversation content: ids, a type, a duration.
 */

export const CONVERSATION_ANALYSIS_JOB_NAME = "conversation_intelligence.analyze"

export const conversationAnalysisJobPayloadSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  /** The `conversation_analyses` row to fill in. The idempotency key. */
  analysisId: z.string().min(1).max(128),
  subjectType: z.enum(["email_thread", "whatsapp_conversation", "call"]),
  subjectId: z.string().min(1).max(128),
  analysisType: z.enum(["summary", "sentiment", "action_items", "key_topics"]),
  /** Whose permissions the analysis inherits. Never a role. */
  actorId: z.string().min(1).max(128),
  correlationId: z.string().max(128).nullish(),
})

export type ConversationAnalysisJobPayload = z.infer<typeof conversationAnalysisJobPayloadSchema>

export type ConversationAnalysisJobResult = {
  analysisId: string
  status: string
  totalTokens: number
}

/** What the bootstrap binds: `service.runQueuedConversationAnalysis`. */
export type ConversationAnalysisRunnerPort = (
  payload: ConversationAnalysisJobPayload,
) => Promise<ConversationAnalysisJobResult>

export class ConversationAnalysisRunnerNotBoundError extends Error {
  readonly code = "CONVERSATION_ANALYSIS_RUNNER_NOT_BOUND"
  constructor() {
    super(
      "no conversation-analysis runner is registered: call registerConversationAnalysisRunner() from the worker bootstrap",
    )
    this.name = "ConversationAnalysisRunnerNotBoundError"
  }
}

const unboundRunner: ConversationAnalysisRunnerPort = async () => {
  throw new ConversationAnalysisRunnerNotBoundError()
}

let runner: ConversationAnalysisRunnerPort = unboundRunner

export function registerConversationAnalysisRunner(next: ConversationAnalysisRunnerPort): void {
  runner = next
}

/** Restores the unbound default (tests, and a clean shutdown). */
export function resetConversationAnalysisRunner(): void {
  runner = unboundRunner
}

/**
 * Run one queued analysis.
 *
 * Retryable: the domain service returns an already-terminal row
 * untouched, so a BullMQ retry after a lost acknowledgement cannot bill
 * for a second analysis. Observable: one JSON line, ids only.
 */
export async function runConversationAnalysisJob(
  input: unknown,
): Promise<ConversationAnalysisJobResult> {
  const payload = conversationAnalysisJobPayloadSchema.parse(input)
  const start = Date.now()
  const result = await runner(payload)
  console.log(
    JSON.stringify({
      level: "info",
      msg: "conversation_analysis_completed",
      workspaceId: payload.workspaceId,
      analysisId: payload.analysisId,
      subjectType: payload.subjectType,
      // No subject content, no prompt, no answer — ids and counters only.
      analysisType: payload.analysisType,
      status: result.status,
      totalTokens: result.totalTokens,
      durationMs: Date.now() - start,
      ...(payload.correlationId === undefined || payload.correlationId === null
        ? {}
        : { correlationId: payload.correlationId }),
    }),
  )
  return result
}
