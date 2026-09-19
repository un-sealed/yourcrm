# `@yourcrm/workflows`

Transport boundary for the workflow automation engine (spec 25, P0).

## What lives where

| Concern                                                                                                             | Home                                                  |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Engine decisions — trigger matching, FilterTree conditions, permission inheritance, run/step records, cascade depth | `@yourcrm/crm/src/automation`                         |
| Queue seam — job name, validated payload, deterministic job id, depth guard, ports                                  | **here** (`src/queue.ts`)                             |
| BullMQ handler                                                                                                      | `apps/worker/src/jobs/automation.ts`                  |
| `workflows` / `workflow_runs` / `workflow_run_steps`                                                                | `@yourcrm/database` (migration `0190_automation.sql`) |

The split is disjoint: no logic is duplicated across it, and this package
stays free of Hono, Postgres, Redis and BullMQ so it can be imported from
anywhere. Swapping BullMQ for Temporal means writing one adapter against
`WorkflowRunQueuePort` — no domain code changes.

```ts
import {
  WORKFLOW_RUN_JOB_NAME,
  workflowRunJobId,
  workflowRunJobPayloadSchema,
  createInMemoryWorkflowRunQueue,
} from "@yourcrm/workflows"
```

## Idempotency

`workflowRunJobId({ workspaceId, workflowId, triggerEventId })` is derived
from the _triggering event_, not the run, and mirrors the UNIQUE
`(workflow_id, trigger_event_id)` index the domain service writes against.
A redelivered event therefore collapses onto the same job id and the same
run row — the two guards use the same key and cannot disagree.

## Loop protection

`depth` and `maxDepth` travel in the payload;
`assertWorkflowCascadeDepth()` refuses anything past the ceiling. The
ceiling itself is a domain rule (`WORKFLOW_MAX_CASCADE_DEPTH` in
`@yourcrm/crm/src/automation`) rather than a second constant here.

## Extension points

- `runAt` on `enqueueWorkflowRun` is where delays, scheduled waits and
  cron triggers land (BullMQ `delay`, Temporal timer).
- `WorkflowRunnerPort` is what a worker process binds to execute a payload.

## Dependency note

No workspace package declares `@yourcrm/workflows` yet, and module agents
may not edit `package.json`. Until an integrator adds it to
`@yourcrm/crm`, `@yourcrm/api` and `@yourcrm/worker`, those three restate
the small structural contracts they need (the queue port, the payload
schema) with a comment pointing back here. This package is the canonical
definition.
