import { z } from "zod"

/**
 * Sequence-step job (spec 47-sales-engagement, P0).
 *
 * The worker half of the sequences queue seam. The engine's decisions —
 * exit conditions, step idempotency, permission inheritance, scheduling —
 * all live in `@yourcrm/crm/src/sequences`; the API enrols somebody and
 * enqueues their first step, each executed step enqueues the next, and
 * this handler makes them run on a worker instead of in the request path.
 *
 * Like `automation.ts` and `import-export.ts`, the payload schema is
 * restated here rather than imported: this file is the process boundary,
 * and spec 01 requires a job to be a pure function of ITS OWN validated
 * input. The canonical port is `SalesSequenceStepQueuePort` in
 * `@yourcrm/crm/src/sequences/types.ts`; keep the two in step.
 *
 * WHY THE RUNNER IS INJECTED
 * --------------------------
 * The same reason the automation job injects one: the handler must not
 * construct a domain service (that would pull a live database connection
 * into every worker import, including the tests that mount the registry).
 * The worker bootstrap registers it once:
 *
 * ```ts
 * registerSequenceStepRunner(async (payload) =>
 *   sequenceService.executeStep(payload.workspaceId, payload.enrollmentId, payload.stepIndex),
 * )
 * ```
 *
 * Until it does, the default runner fails loudly, so a misconfigured
 * deployment dead-letters visibly instead of silently dropping outreach.
 *
 * THE PROPERTIES ARE NOT RE-IMPLEMENTED HERE — AND CANNOT BE WEAKENED
 * ------------------------------------------------------------------
 *  - EXIT CONDITIONS: the runner re-reads the enrollment's status first
 *    and does nothing unless it is still `active`. A job queued before the
 *    prospect replied is therefore harmless by construction; the transport
 *    never has to cancel anything, and a delayed job that survives a
 *    restart cannot resurrect a stopped sequence.
 *  - IDEMPOTENCY: the enqueue uses a deterministic job id derived from
 *    (enrollment, step index) — BullMQ ignores a duplicate `jobId` — and
 *    the runner claims the same pair in Postgres before it sends. Same
 *    key, so the two can never disagree, and retrying this job is safe.
 *  - PERMISSION INHERITANCE: the payload carries no actor. The runner
 *    resolves the sequence owner's live role; there is nothing here a
 *    caller could spoof.
 */

/** Registered in `apps/worker/src/worker.ts`'s `JobHandlers` under this name. */
export const SEQUENCE_STEP_JOB_NAME = "sequence.step"

export const sequenceStepJobPayloadSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  sequenceId: z.string().min(1).max(128),
  enrollmentId: z.string().min(1).max(128),
  stepIndex: z.number().int().min(0).max(1000),
  correlationId: z.string().max(128).optional(),
})

export type SequenceStepJobPayload = z.infer<typeof sequenceStepJobPayloadSchema>

export type SequenceStepResult = {
  enrollmentId: string
  stepIndex: number
  outcome: string
  status: string
  error?: string
}

/** What the bootstrap binds: usually `service.executeStep`. */
export type SequenceStepRunnerPort = (
  payload: SequenceStepJobPayload,
) => Promise<SequenceStepResult>

export class SequenceStepRunnerNotBoundError extends Error {
  readonly code = "SEQUENCE_RUNNER_NOT_BOUND"
  constructor() {
    super(
      "no sequence step runner is registered: call registerSequenceStepRunner() from the worker bootstrap",
    )
    this.name = "SequenceStepRunnerNotBoundError"
  }
}

const unboundRunner: SequenceStepRunnerPort = async () => {
  throw new SequenceStepRunnerNotBoundError()
}

let runner: SequenceStepRunnerPort = unboundRunner

export function registerSequenceStepRunner(next: SequenceStepRunnerPort): void {
  runner = next
}

/** Restores the unbound default (tests, and a clean shutdown). */
export function resetSequenceStepRunner(): void {
  runner = unboundRunner
}

/**
 * Deterministic transport-level job id.
 *
 * The authoritative send-once guard is the UNIQUE
 * (enrollment_id, step_index) index behind `claimStepRun`. This is the
 * cheap second line: BullMQ ignores an `add()` whose `jobId` already
 * exists, so a duplicate enqueue does not even occupy a worker slot. Same
 * key as the database claim, so the two can never disagree.
 */
export function sequenceStepJobId(payload: {
  workspaceId: string
  enrollmentId: string
  stepIndex: number
}): string {
  return `${SEQUENCE_STEP_JOB_NAME}:${payload.workspaceId}:${payload.enrollmentId}:${payload.stepIndex}`
}

/**
 * Execute one due sequence step. Retryable (the runner is idempotent),
 * observable (JSON log with the enrollment and correlation ids) and
 * validated at run time as well as at enqueue.
 *
 * Note what is NOT logged: no subject, no body, no recipient address.
 * Spec 47 §17 — never log message content unnecessarily.
 */
export async function runSequenceStepJob(input: unknown): Promise<SequenceStepResult> {
  const payload = sequenceStepJobPayloadSchema.parse(input)
  const start = Date.now()
  const result = await runner(payload)
  console.log(
    JSON.stringify({
      level: "info",
      msg: "sequence_step_executed",
      job: SEQUENCE_STEP_JOB_NAME,
      workspaceId: payload.workspaceId,
      sequenceId: payload.sequenceId,
      enrollmentId: payload.enrollmentId,
      stepIndex: payload.stepIndex,
      outcome: result.outcome,
      status: result.status,
      durationMs: Date.now() - start,
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(payload.correlationId === undefined ? {} : { correlationId: payload.correlationId }),
    }),
  )
  return result
}
