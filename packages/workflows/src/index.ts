/**
 * `@yourcrm/workflows` — automation engine boundary (Phase 2).
 *
 * INTENTIONAL PLACEHOLDER. Workflow definitions trigger off domain events
 * (`AutomationEvents`) and execute steps as idempotent BullMQ jobs via
 * apps/worker. Keep the BullMQ abstraction here so Temporal can replace the
 * backend later without touching domain code.
 */

export const WORKFLOWS_BOUNDARY_VERSION = 0 as const

export type WorkflowTrigger = {
  event: string
  workspaceId: string
}
