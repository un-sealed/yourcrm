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

## AI governance & approval queue (`src/ai-governance`, spec 38)

The gate every AI write passes through. An AI agent does not mutate
records — it proposes an action, a human decides, and only then does the
governance service call the owning module's domain service.

```ts
import { createAiGovernanceService } from "@yourcrm/crm/src/ai-governance"
```

The port an AI agent calls is `AiActionProposalPort.requestAction(ctx,
input)`: object type, record id, `create | update | delete |
send_external`, a before/after diff, a mandatory rationale, and the model
and run id that produced it. There is no `apply` on that port.

Beyond `store` / `audit` / `events` it takes two more ports:

- `applier: AiActionApplierPort` — the DOMAIN SERVICES that actually make
  the change (and restore `before` on revert). Governance never writes
  another module's tables; the integrator wires the concrete services in
  `apps/api/src/routes/modules/ai-governance.ts`.
- `resolveActorRole: AiActorRoleResolver` — the LIVE workspace role, for
  the requesting actor _and_ the approver. Same shape and same answer as
  automation's resolver.

**No privilege escalation**: an approved action runs with the
intersection of the requester's and the approver's permissions — the
shared `requirePermission()` is called once per actor against the same
target action, so neither can lend the other rights. Both roles are
re-read at decision time.

**No self-approval**: the requesting actor cannot approve its own
request, and any non-`user` actor is refused outright — an AI can never
approve. Rejecting your own proposal is allowed; refusal is the safe
direction.

**Exactly-once apply**: a UNIQUE index on `ai_action_approvals
(request_id)` means one decision per request, and applying starts with a
conditional claim (`status = 'approved' AND apply_claimed_at IS NULL`).
The loser of the race returns `applied: false` without reaching the
applier. A failed apply keeps its claim.

**Policies**: `resolveAiPolicy` is a pure function — most specific scope
wins, and an unmatched `(object, action)` pair means `require_approval`.
Auto-apply is opt-in per scope, by an admin.

**Attribution**: request, approval, rejection, apply and revert each write
an audit row with `source: "ai"` carrying model, run id, actor and
correlation id (`airq:<requestId>` when the proposer supplied none).

## AI agents (`src/ai-agents`, spec 36)

A named, scoped, triggerable LLM loop: stored instructions, an
allowlisted subset of the ASSISTANT's read tools, a trigger (manual or a
domain event), an owner whose permissions it inherits, and hard budgets.

```ts
import { createAiAgentService, createAiAgentToolRegistry } from "@yourcrm/crm/src/ai-agents"
```

**Reads happen. Writes never do.** The tool registry holds the
assistant's read tools verbatim plus one `propose` tool,
`crm_propose_change`, which calls
`AiActionProposalPort.requestAction` and returns — an `ai_action_request`
for a human, and nothing else. `AiAgentServiceDeps` contains no applier,
no domain service and no repository beyond this module's own two tables,
so there is no code path from an agent to a mutation.
`createAiAgentToolRegistry` refuses any tool whose access is not `read`
or `propose`, and the assistant's `createAiToolRegistry` refuses a
non-read tool before that.

**Bounded loops**: `maxSteps`, `maxToolCalls` and `maxTotalTokens` live on
the definition, are CHECK-constrained to their ceilings in migration
0400, and are clamped again with `clampAiAgentBudget` at execution — a
hand-edited row cannot buy an unbounded loop. A run that hits a ceiling
terminates with status `exhausted`, which is deliberately not `failed`.

**Permission inheritance**: a run executes as the agent's OWNER, whose
role is re-resolved LIVE (`AiAgentActorRoleResolver`) at execution time;
a removed owner refuses the run. Every tool then calls
`requirePermission()` — the read tools themselves, and `requestAction`
for a proposal, which re-checks the live role against the target action.
A viewer-owned agent sees what a viewer sees and cannot propose at all.

**Idempotency**: a run is keyed on the triggering event id
(UNIQUE `(agent_id, trigger_event_id)`), so a redelivery is a no-op and
an agent never spends its tokens twice. `executeRun` is additionally a
no-op on a run that already reached a terminal status.

**Cost**: every run records steps, tool calls, proposals, prompt and
completion tokens, latency and `cost_micros`, attributable to a model and
a run id; every tool call writes an audit row with `source: "ai"` and
`correlationId = agentrun:<runId>`, which is also how `dispatch` derives
cascade depth.

`subscribeAiAgentDispatcher(bus, service)` connects agents to the event
bus — call it from the app bootstrap, never from a route factory.
Execution runs on the worker through `AiAgentRunQueuePort`; domain code
never imports BullMQ.
