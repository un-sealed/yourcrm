# `@yourcrm/database`

Shared database access layer — the ONLY place postgres connections are created.

- `src/client.ts` — `getDb()` singleton / `closeDb()`. Apps and domain
  services import this; never call `postgres()` elsewhere.
- `src/schema/` — Drizzle table definitions. `base.ts` holds the
  `BaseRecord` column contract every business table spreads in.
- `src/repositories/` — `createBaseRepository()` gives domain repos
  workspace scoping, soft-delete filtering and cursor pagination.
- `migrations/*.sql` — applied in order by `src/migrate.ts`
  (`bun run db:migrate`). Transaction-safe, recorded in `schema_migrations`.
- `src/seed.ts` — deterministic demo data (`bun run db:seed`,
  `SEED_RESET=1` removes it).
- `drizzle.config.ts` — `bun run db:generate` (drizzle-kit) for later agents.

pgvector / pg_trgm are enabled in `0000_extensions.sql` for future AI
retrieval and fuzzy search. Domain tables (people, companies, leads, …)
are added by module agents following the `0001_foundation.sql` pattern.

## People tables (module reference)

- `src/schema/people.ts` — `people` (+ `person_emails`, `person_phones`).
  `company_id` is a plain uuid with an index and no FK (companies land
  later); contact tables FK to `people(id)` with cascade.
- `src/repositories/people-repository.ts` — `createPeopleRepository()`
  wraps `createBaseRepository(people)` and adds search, contact methods
  and one-primary-per-channel enforcement. Import via subpath (repositories
  are not barrelled):
  `import { createPeopleRepository } from "@yourcrm/database/src/repositories/people-repository"`
- `migrations/0010_people.sql` — the DDL mirror of the schema file.

## Search index (cross-module contract)

- `src/schema/search.ts` — `search_index`, one denormalized row per indexed
  record. `record_id` is a plain uuid with an index and no FK (it points into
  whichever module table `object_type` names). `search_vector` is a GENERATED
  STORED `tsvector` (`simple` config, weighted title/subtitle/body) behind a
  GIN index. `owner_id` + `visibility` carry the record-level permission facts
  the query filters on.
- `src/repositories/search-repository.ts` — `createSearchRepository()` with
  `upsert` (idempotent on workspace + object type + record id),
  `removeByRecord`, `findByRecord` and a ranked `query`. Import via subpath.
- `migrations/0110_search.sql` — the DDL mirror of the schema file.

Modules do not write this table directly: they call the indexing service in
`@yourcrm/crm/src/search`, which applies permissions and audit.

## Workflow automation tables (engine contract)

- `src/schema/automation.ts` — `workflows` (definition: trigger event,
  FilterTree conditions, ordered actions, enabled/disabled),
  `workflow_runs` (one per triggering event) and `workflow_run_steps`
  (one per action attempt). Foreign keys stay inside this migration;
  `owner_id` / `actor_id` are plain uuid columns.
- Two UNIQUE indexes carry the engine's guarantees, not hygiene:
  - `workflow_runs_event_idx (workflow_id, trigger_event_id)` —
    IDEMPOTENCY. A redelivered event cannot create a second run.
  - `workflow_run_steps_index_idx (run_id, step_index)` — the per-step
    claim. A retried job resumes instead of re-applying an action.
    `createRun` and `claimRunStep` insert `ON CONFLICT DO NOTHING` and
    report `created` / `claimed`, so idempotency is a Postgres result the
    domain service reads rather than a decision it makes.
- `workflow_runs.depth` is the cascade counter behind loop protection.
- `src/repositories/automation-repository.ts` — CRUD, the two idempotent
  writes, run history, plus the action sinks (`updateTargetField`,
  `attachTagByName`, `createNotification`). `WORKFLOW_TARGET_OBJECTS` is
  an allowlist of objects and writable fields in the same spirit as
  `REPORT_OBJECTS`: naming a field is the only way to make an automation
  able to write it, and each write goes through the owning module's own
  repository so no business rule is duplicated.
- `migrations/0190_automation.sql` — the DDL mirror of the schema file.

## AI governance tables (approval-queue contract)

- `src/schema/ai-governance.ts` — `ai_policies` (per object + action:
  `require_approval` | `auto_apply` | `forbidden`), `ai_action_requests`
  (one proposed mutation: actor, model, run id, polymorphic target,
  before/after diff, rationale, lifecycle) and `ai_action_approvals` (the
  one human decision a request may receive).
- The target of an action is the POLYMORPHIC pair
  (`object_type`, `record_id`) with no foreign key: this module governs
  objects whose modules may not exist yet, and applying always goes
  through the owning module's domain service.
- Two database facts carry the module's guarantees, not hygiene:
  - `ai_action_approvals_request_idx (request_id)` UNIQUE — one decision
    per request, forever. `recordDecision` inserts
    `ON CONFLICT DO NOTHING` and reports `created`.
  - `ai_action_requests.apply_claimed_at` / `revert_claimed_at` —
    claim-before-apply. `claimRequestApply` is a conditional UPDATE on
    `status = 'approved' AND apply_claimed_at IS NULL`, so exactly one
    caller can ever apply a request; everybody else gets
    `claimed: false`.
- `ai_policies_scope_idx` is UNIQUE per workspace `WHERE deleted_at IS
NULL`, so a scope has one live rule and can be re-created after
  deletion. The column default is `require_approval` — the deny-by-human
  default lives in the DDL too.
- `src/repositories/ai-governance-repository.ts` — policy CRUD, request
  CRUD, the two claims and the one decision, with statuses, actions,
  actor types, decisions and modes validated against the schema
  allowlists before they reach SQL.
- `migrations/0350_ai_governance.sql` — the DDL mirror of the schema file.
## Settings, teams & compliance tables (spec 40 + 41)

- `src/schema/settings.ts` — `workspaceTeams` (`teams`),
  `workspaceTeamMembers` (`team_members`), `workspaceInvites` and
  `dataRequests`. Exports are prefixed because one generated barrel covers
  every module's schema. `membership_id` and `subject_id` are plain indexed
  uuids: `memberships` and `people` belong to other modules.
- The **workspace profile is the `workspaces` row**, not a side table:
  `0320_settings.sql` added `date_format`, `logo_url`, `brand_color` and
  `support_email` next to the existing name/timezone/currency, so a
  workspace has exactly one source of truth.
- `workspace_invites.token_hash` is the SHA-256 hex of a 32-byte CSPRNG
  token (`@yourcrm/auth` `tokens.ts` — the session primitive). The raw
  token is never stored; resending rotates the hash and the expiry.
- `data_requests` (GDPR/DPDP) stores ids and status only. An export is
  assembled live from the owning module when it is downloaded, so
  answering a privacy request never duplicates the subject's data at rest.
- `src/repositories/settings-repository.ts`,`teams-repository.ts`,
  `compliance-repository.ts` — imported by subpath. They share a keyset
  cursor over `(created_at, id)` (`encodeSettingsCursor`), which the
  foundation's id-only cursor does not provide.

### `audit_events` is append-only — enforced

`createAuditLogReader()` has exactly two methods, `list` and `findById`.
There is no update, delete or restore on the audit path anywhere, and
`0320_settings.sql` installs `audit_events_reject_mutation()` plus two
triggers that make UPDATE, DELETE and TRUNCATE on `audit_events` raise.
`writeAudit()` only inserts, so nothing legitimate is affected; a future
"fix up an audit row" patch fails loudly instead of succeeding quietly.

## AI agent tables (spec 36)

- `src/schema/ai-agents.ts` — `ai_agents` (instructions, model, the
  allowlisted tool names, trigger, owner and the per-run budgets) and
  `ai_agent_runs` (one execution: trigger, steps, tool calls, proposals,
  tokens, latency, `cost_micros`, outcome and a `step_log` of tool names,
  outcomes, durations and proposal ids).
- There is no agent-action table on purpose: an agent never changes a
  record, so a proposed change is an `ai_action_requests` row owned by the
  approval queue (0350), and `step_log` carries the request ids.
- The database facts that carry the module's guarantees:
  - `ai_agent_runs_event_idx (agent_id, trigger_event_id)` UNIQUE — one
    run per triggering event, forever. `createRun` inserts
    `ON CONFLICT DO NOTHING` and reports `created`, which is what makes a
    redelivered event cost nothing.
  - `max_steps` / `max_tool_calls` / `max_total_tokens` are CHECK-bounded
    to the domain layer's ceilings (12 / 24 / 200000), so writing straight
    to the table cannot widen a budget.
  - `depth` + `parent_run_id` carry cascade-loop protection, as on
    `workflow_runs`.
- `src/repositories/ai-agents-repository.ts` — definition CRUD, the
  idempotent run insert, run history and the accounting update, with
  statuses, trigger types and tool names validated against the schema
  allowlists before they reach SQL. Nothing in it writes another module's
  table.
- `migrations/0400_ai_agents.sql` — the DDL mirror of the schema file.
