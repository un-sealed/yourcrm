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
