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
## Settings, security & compliance (`src/settings`, specs 40 + 41)

```ts
import {
  createWorkspaceSettingsService, // workspace profile, members, invitations
  createWorkspaceTeamService, // teams + membership edges
  createComplianceService, // audit-log viewer + GDPR/DPDP requests
} from "@yourcrm/crm/src/settings"
```

**Privilege escalation is the risk in this module**, so every mutation
passes two gates: `requirePermission({ action: "admin" })` (the shared
role-rank policy), then a relational guard from `settings/roles.ts` that
`@yourcrm/permissions` cannot express because it depends on the target row
and the rest of the workspace:

1. nobody changes their own role (self-promotion),
2. only an owner may re-rank, deactivate or reactivate an owner,
3. nobody grants a role above their own, and the **last owner** can be
   neither demoted nor deactivated.

Both kinds of denial surface as the same `PermissionDeniedError` / 403.

**Invites are tokens, not passwords.** `invite()` takes a
`WorkspaceInviteTokenPort` (the API binds it to `generateSessionToken` /
`hashSessionToken`; this package does not depend on `@yourcrm/auth`),
returns the raw token exactly once and stores only its hash with an
expiry. `checkInviteUsable()` is the pure expiry/revocation rule the
signup flow will call.

**The audit port is read-only by type.** `WorkspaceAuditLogPort` declares
`list` and `findById` and nothing else, so no service, route or refactor
can modify an audit row; the table also rejects mutation in Postgres.

**No domain events in P0 (blocker, not an omission):** `@yourcrm/events`
has no settings/team/security group (`security.setting_changed`,
`user.invited`, `role.updated`, `team.member_added`), and this module may
neither add one nor use string literals — so it audits every mutation and
emits nothing.

Out of P0 scope and deliberately not stubbed: SSO (SAML/OIDC), SCIM, MFA,
IP allowlists, encryption-key rotation.
