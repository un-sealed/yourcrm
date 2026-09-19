import { z } from "zod"
import { AutomationEvents } from "@yourcrm/events"

/**
 * Workflow-run job (spec 25-automation, P0).
 *
 * This is the worker half of the queue seam. The engine's decisions —
 * trigger matching, conditions, permission inheritance, run and step
 * records, cascade depth — all live in `@yourcrm/crm/src/automation`; the
 * API dispatcher records a run and enqueues it, and this handler makes it
 * execute on a worker instead of in the request path.
 *
 * Like `import-export.ts`, the payload schema is restated here rather than
 * imported: this file is the process boundary, and spec 01 requires a job
 * to be a pure function of ITS OWN validated input. The canonical contract
 * (job name, payload, deterministic job id) is
 * `@yourcrm/workflows`' `queue.ts`; keep the two in step.
 *
 * WHY THE RUNNER IS INJECTED
 * --------------------------
 * `@yourcrm/worker` declares neither `@yourcrm/crm` nor
 * `@yourcrm/database`, and agents may not edit `package.json`, so this
 * file cannot construct the domain service itself. It therefore takes a
 * `WorkflowRunnerPort` that the worker bootstrap registers once:
 *
 * ```ts
 * registerWorkflowRunner(async (payload) =>
 *   automationService.executeRun(payload.workspaceId, payload.runId),
 * )
 * ```
 *
 * Until that dependency is declared the default runner fails loudly, so a
 * misconfigured deployment dead-letters visibly instead of silently
 * dropping automations.
 *
 * The three properties are NOT re-implemented here — they cannot be
 * weakened by the transport either:
 *  - IDEMPOTENCY: the enqueue uses a deterministic job id derived from the
 *    triggering event, and `executeRun` is a no-op on a run that already
 *    reached a terminal status. Retrying this job is safe by construction.
 *  - PERMISSION INHERITANCE: the payload carries no actor. The runner
 *    resolves the workflow owner's live role; there is nothing here a
 *    caller could spoof.
 *  - LOOP PROTECTION: the payload carries `depth` and `maxDepth`, and the
 *    handler refuses to run past the ceiling — a replayed or hand-crafted
 *    payload cannot outrun the dispatcher's guard.
 */

export const AUTOMATION_RUN_JOB_NAME = "automation.run"

export const automationRunJobPayloadSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  workflowId: z.string().min(1).max(128),
  runId: z.string().min(1).max(128),
  /** Envelope id of the triggering event — the idempotency key. */
  triggerEventId: z.string().min(1).max(128),
  depth: z.number().int().min(0).max(100),
  maxDepth: z.number().int().min(0).max(100),
  correlationId: z.string().max(64).optional(),
})

export type AutomationRunJobPayload = z.infer<typeof automationRunJobPayloadSchema>

export type AutomationRunResult = {
  runId: string
  status: string
  executedSteps: number
}

/** What the bootstrap binds: usually `service.executeRun`. */
export type WorkflowRunnerPort = (payload: AutomationRunJobPayload) => Promise<AutomationRunResult>

export class WorkflowRunnerNotBoundError extends Error {
  readonly code = "WORKFLOW_RUNNER_NOT_BOUND"
  constructor() {
    super(
      "no workflow runner is registered: call registerWorkflowRunner() from the worker bootstrap",
    )
    this.name = "WorkflowRunnerNotBoundError"
  }
}

export class AutomationCascadeLimitError extends Error {
  readonly code = "WORKFLOW_CASCADE_LIMIT"
  constructor(depth: number, maxDepth: number) {
    super(`workflow cascade depth ${depth} exceeds the maximum of ${maxDepth}`)
    this.name = "AutomationCascadeLimitError"
  }
}

const unboundRunner: WorkflowRunnerPort = async () => {
  throw new WorkflowRunnerNotBoundError()
}

let runner: WorkflowRunnerPort = unboundRunner

export function registerWorkflowRunner(next: WorkflowRunnerPort): void {
  runner = next
}

/** Restores the unbound default (tests, and a clean shutdown). */
export function resetWorkflowRunner(): void {
  runner = unboundRunner
}

/**
 * Execute one queued workflow run. Retryable (the runner is idempotent),
 * observable (JSON log with the run and correlation ids) and validated at
 * run time as well as at enqueue.
 */
export async function runAutomationJob(input: unknown): Promise<AutomationRunResult> {
  const payload = automationRunJobPayloadSchema.parse(input)
  const start = Date.now()
  if (payload.depth > payload.maxDepth) {
    throw new AutomationCascadeLimitError(payload.depth, payload.maxDepth)
  }
  const result = await runner(payload)
  console.log(
    JSON.stringify({
      level: "info",
      msg: "automation_run_executed",
      // The run emits AutomationEvents.{RunStarted,StepFailed,Completed}
      // from the domain service; this line is the transport's own trace.
      event: AutomationEvents.Completed,
      workspaceId: payload.workspaceId,
      workflowId: payload.workflowId,
      runId: payload.runId,
      triggerEventId: payload.triggerEventId,
      depth: payload.depth,
      status: result.status,
      executedSteps: result.executedSteps,
      durationMs: Date.now() - start,
      ...(payload.correlationId === undefined ? {} : { correlationId: payload.correlationId }),
    }),
  )
  return result
}
