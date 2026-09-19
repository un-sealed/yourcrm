# `@yourcrm/crm`

Domain-service boundary for all CRM modules (people, companies, leads,
deals, pipelines, activities, tasks, …). Placeholder in Phase 0 — it
establishes the import direction so API/MCP/AI agents consume services,
never repositories directly.

## Module services (people is the golden reference)

Each module lives in `src/<module>/` with its own barrel and is imported
via subpath until the integrator extends `scripts/gen-barrels.ts` past
top-level files:

```ts
import { createPeopleService } from "@yourcrm/crm/src/people"
```

The service takes structural ports — no database dependency in this
package. The API layer adapts the drizzle repository and `writeAudit`:

```ts
createPeopleService({ store, audit, events })
```

Every method calls `requirePermission()` first, works through `store`,
emits via the `CrmEvents` constant, and audits mutations with
before/after. See `src/people/service.ts` and mirror it exactly.

## Workflow automation (`src/automation`, spec 25)

An engine rather than a CRUD module: the other modules already emit
domain events, and a workflow is stored reaction to one of them.

```ts
import { createWorkflowAutomationService } from "@yourcrm/crm/src/automation"
```

Beyond the usual `store` / `audit` / `events` ports it takes three more,
each guarding one property:

- `queue: WorkflowRunQueuePort` — runs are queued, never executed in the
  request path. Canonical definition in `@yourcrm/workflows`; restated
  structurally here for the same reason `AuditWriter` is.
- `executor: WorkflowActionExecutorPort` — the bindings to the modules
  that actually do the work (tasks service, record update, tag, in-app
  notification), so the engine duplicates no business rules.
- `resolveActorRole: WorkflowActorRoleResolver` — the workflow owner's
  LIVE workspace role.

**Idempotency**: a run is keyed on the triggering event id; `createRun`
reports `created: false` on redelivery and nothing is enqueued. Each
action claims its `(run, index)` slot before executing, and re-executing a
terminal run is a no-op.

**Permission inheritance**: actions execute as the workflow's owner. The
owner's role is re-read at run time, the run is refused if they are no
longer a member, and every action calls `requirePermission()`
(`access.ts`). Authoring is separate: enabling a workflow or firing a
manual run needs `run_automation`.

**Loop protection**: actions run with `correlationId = wfrun:<runId>`, so
the events they emit name their parent run. `dispatch` derives
`depth = parent.depth + 1` and records a `skipped` run past
`WORKFLOW_MAX_CASCADE_DEPTH` instead of enqueueing it. Engine events
(`workflow.*`) are not in `WORKFLOW_TRIGGER_EVENTS` at all.

`subscribeWorkflowDispatcher(bus, service)` connects the engine to the
event bus — call it from the app bootstrap, never from a route factory.
