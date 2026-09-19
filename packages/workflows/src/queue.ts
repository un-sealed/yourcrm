import { z } from "zod"
import { AutomationEvents } from "@yourcrm/events"

/**
 * The workflow-run queue seam.
 *
 * This is the boundary the `@yourcrm/workflows` placeholder reserved:
 * "keep the BullMQ abstraction here so Temporal can replace the backend
 * later without touching domain code". It holds the *contract* — job name,
 * payload, deterministic job id, port — and deliberately no transport.
 * BullMQ lives in `apps/worker/src/queues.ts`; the domain service in
 * `@yourcrm/crm/src/automation` depends on `WorkflowRunQueuePort` and
 * nothing else, so swapping the backend touches one adapter.
 *
 * Division of labour with the domain layer:
 *
 *   @yourcrm/crm/src/automation   decides WHAT runs (trigger matching,
 *                                 conditions, permission inheritance,
 *                                 run + step records, cascade depth)
 *   @yourcrm/workflows (here)     decides HOW a decision travels to a
 *                                 worker (payload, id, dedupe, guards)
 *   apps/worker                   decides WHERE it executes (BullMQ)
 *
 * Nothing here performs I/O, so the contract is testable without Redis.
 */

/** Registered in `apps/worker/src/worker.ts`'s `JobHandlers` under this name. */
export const WORKFLOW_RUN_JOB_NAME = "automation.run"

/**
 * Enqueue payload. Validated at enqueue AND at run time (spec 01: jobs are
 * a pure function of validated input).
 *
 * `maxDepth` travels with the job instead of being a constant here: the
 * cascade ceiling is a domain rule owned by
 * `@yourcrm/crm/src/automation`'s `WORKFLOW_MAX_CASCADE_DEPTH`, and a
 * second copy in the transport is a second copy that can drift.
 */
export const workflowRunJobPayloadSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  workflowId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  /** Envelope id of the event that caused the run — the idempotency key. */
  triggerEventId: z.string().min(1).max(128),
  depth: z.number().int().min(0).max(100),
  maxDepth: z.number().int().min(0).max(100),
  correlationId: z.string().max(64).optional(),
})

export type WorkflowRunJobPayload = z.infer<typeof workflowRunJobPayloadSchema>

/**
 * Deterministic transport-level job id.
 *
 * The authoritative idempotency guard is the UNIQUE
 * (workflow_id, trigger_event_id) index behind `createRun`. This is the
 * cheap second line: BullMQ ignores an `add()` whose `jobId` already
 * exists, so a redelivered event does not even occupy a worker slot.
 * Same key, so the two can never disagree.
 */
export function workflowRunJobId(payload: {
  workspaceId: string
  workflowId: string
  triggerEventId: string
}): string {
  return `${WORKFLOW_RUN_JOB_NAME}:${payload.workspaceId}:${payload.workflowId}:${payload.triggerEventId}`
}

/**
 * Cascade guard at the transport boundary. The dispatcher already refuses
 * to enqueue past the ceiling; this stops a hand-crafted or replayed
 * payload from doing what the dispatcher would not.
 */
export class WorkflowCascadeLimitError extends Error {
  readonly code = "WORKFLOW_CASCADE_LIMIT"
  constructor(
    readonly depth: number,
    readonly maxDepth: number,
  ) {
    super(`workflow cascade depth ${depth} exceeds the maximum of ${maxDepth}`)
    this.name = "WorkflowCascadeLimitError"
  }
}

export function assertWorkflowCascadeDepth(depth: number, maxDepth: number): void {
  if (depth > maxDepth) throw new WorkflowCascadeLimitError(depth, maxDepth)
}

/**
 * What the domain service calls. `apps/api` binds it to a BullMQ adapter
 * (`getQueue(QueueNames.Automation).add(WORKFLOW_RUN_JOB_NAME, payload,
 * { jobId: workflowRunJobId(payload) })`); tests bind
 * `createInMemoryWorkflowRunQueue()`.
 *
 * EXTENSION POINT: `runAt` is the hook scheduled/delayed steps need
 * (spec 25 §3 "delays and scheduled waits", and cron triggers). BullMQ
 * maps it to `{ delay }`; Temporal maps it to a timer. No other part of
 * the contract changes when those land.
 */
export type WorkflowRunQueuePort = {
  enqueueWorkflowRun(payload: WorkflowRunJobPayload & { runAt?: Date }): Promise<void>
}

/** What a worker process binds to actually execute a validated payload. */
export type WorkflowRunnerPort = (
  payload: WorkflowRunJobPayload,
) => Promise<{ runId: string; status: string; executedSteps: number }>

/**
 * Hermetic queue double: records what would have been enqueued and
 * deduplicates on `workflowRunJobId`, exactly as BullMQ does. Tests assert
 * on `jobs` instead of standing up Redis (`docs/conventions.md`).
 */
export function createInMemoryWorkflowRunQueue(
  onEnqueue?: (payload: WorkflowRunJobPayload) => Promise<void> | void,
) {
  const jobs: (WorkflowRunJobPayload & { jobId: string })[] = []
  const seen = new Set<string>()

  return {
    jobs,
    async enqueueWorkflowRun(input: WorkflowRunJobPayload & { runAt?: Date }): Promise<void> {
      const payload = workflowRunJobPayloadSchema.parse(input)
      assertWorkflowCascadeDepth(payload.depth, payload.maxDepth)
      const jobId = workflowRunJobId(payload)
      if (seen.has(jobId)) return
      seen.add(jobId)
      jobs.push({ ...payload, jobId })
      if (onEnqueue) await onEnqueue(payload)
    },
    reset(): void {
      jobs.length = 0
      seen.clear()
    },
  }
}

export type InMemoryWorkflowRunQueue = ReturnType<typeof createInMemoryWorkflowRunQueue>

/**
 * Engine events a run produces, re-exported from `@yourcrm/events` so a
 * worker or transport adapter has one import for the whole seam. Always
 * the constants, never literals.
 */
export const WORKFLOW_RUN_EVENTS = {
  RunStarted: AutomationEvents.RunStarted,
  StepFailed: AutomationEvents.StepFailed,
  Completed: AutomationEvents.Completed,
} as const
