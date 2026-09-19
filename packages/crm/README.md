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
