/**
 * `@yourcrm/workflows` — automation-engine transport boundary.
 *
 * The placeholder this file replaced reserved the seam described in
 * `docs/architecture.md`: workflow runs execute as idempotent BullMQ jobs
 * via `apps/worker`, and the queue abstraction lives here so Temporal can
 * replace the backend without touching domain code.
 *
 * WHAT LIVES WHERE (spec 25-automation, P0)
 * -----------------------------------------
 *   @yourcrm/crm/src/automation   the engine's decisions — trigger
 *                                 matching, FilterTree conditions,
 *                                 permission inheritance, run/step
 *                                 records, cascade depth. It is domain
 *                                 logic, so it sits in the domain layer
 *                                 next to `requirePermission()`.
 *   @yourcrm/workflows (here)     how a decision reaches a worker — job
 *                                 name, validated payload, deterministic
 *                                 job id, dedupe, depth guard, ports.
 *   apps/worker/src/jobs/         the BullMQ handler that binds a runner
 *     automation.ts               to the payload.
 *   @yourcrm/database             `workflows` / `workflow_runs` /
 *                                 `workflow_run_steps` (migration 0190).
 *
 * The split is disjoint on purpose: no logic is duplicated across it, and
 * this package stays free of Hono, Postgres, Redis and BullMQ so it can be
 * imported from anywhere.
 *
 * DEPENDENCY NOTE: no workspace package declares `@yourcrm/workflows` as a
 * dependency yet, and agents may not edit `package.json`. Until an
 * integrator adds it to `@yourcrm/crm`, `@yourcrm/api` and
 * `@yourcrm/worker`, those three restate the small structural contracts
 * they need (`WorkflowRunQueuePort`, the payload schema) with a comment
 * pointing back here — the same pattern `AuditWriter` and the FilterTree
 * already follow. This file is the canonical definition.
 */

export const WORKFLOWS_BOUNDARY_VERSION = 0 as const

export {
  assertWorkflowCascadeDepth,
  createInMemoryWorkflowRunQueue,
  WorkflowCascadeLimitError,
  workflowRunJobId,
  workflowRunJobPayloadSchema,
  WORKFLOW_RUN_EVENTS,
  WORKFLOW_RUN_JOB_NAME,
} from "./queue"
export type {
  InMemoryWorkflowRunQueue,
  WorkflowRunJobPayload,
  WorkflowRunnerPort,
  WorkflowRunQueuePort,
} from "./queue"
