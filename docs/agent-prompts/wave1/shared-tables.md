# Wave 1 — Shared Tables Agent

Branch: `agent/shared-tables`

You own the cross-cutting tables that nearly every module spec's §6 Data Model
references: tags, relationships, custom fields, saved views. If a module agent
had to define these, eleven modules would define eleven versions.

Specs: `docs/yourcrm-agent-spec-pack/03-data-model.md`,
`docs/yourcrm-agent-spec-pack/33-custom-objects-fields.md`,
`docs/yourcrm-agent-spec-pack/DATA-MODEL-CONTRACTS.md`

## You own, exclusively

```text
packages/database/src/schema/tags.ts            (new)
packages/database/src/schema/relationships.ts   (new)
packages/database/src/schema/custom-fields.ts   (new)
packages/database/src/schema/saved-views.ts     (new)
packages/database/src/schema/index.ts
packages/database/src/repositories/tags-repository.ts        (new)
packages/database/src/repositories/relationships-repository.ts (new)
packages/database/src/repositories/custom-fields-repository.ts (new)
packages/database/src/repositories/saved-views-repository.ts   (new)
packages/database/migrations/0003_shared_tables.sql          (new)
```

Your migration slot is **0003**. Do not use any other number.
Do **not** touch `packages/database/src/audit.ts`, `repositories/index.ts` or
`src/index.ts` — the platform-seams agent owns those this wave. Export your
repositories from your own files; the integrator wires the barrel.

## Tables

All follow `baseColumns` from `schema/base.ts` — id, workspace, timestamps,
actors, soft delete.

- **tags** — workspace-scoped, name, color, unique per workspace on name
- **taggables** — polymorphic join: `tag_id`, `object_type`, `record_id`
- **relationships** — `source_type`, `source_id`, `target_type`, `target_id`,
  `relationship_type`, optional `label`, optional `metadata` jsonb
- **custom_field_definitions** — `object_type`, key, label, field type
  (text/number/date/select/multiselect/boolean/url/email), options jsonb,
  required flag, display order
- **custom_field_values** — `definition_id`, `record_id`, value jsonb
- **saved_views** — `object_type`, name, owner, `is_shared`, filter tree jsonb,
  column config jsonb, sort jsonb

## Rules

- **Polymorphic references are plain columns, never foreign keys.** The tables
  they point at (people, deals, …) do not exist yet and are created by later
  agents. Index `(object_type, record_id)` instead.
- Additive, transaction-safe SQL following
  `packages/database/migrations/0001_foundation.sql` conventions.
- Keep the Drizzle schema and the raw SQL migration in agreement — a mismatch
  breaks every downstream agent's `db:migrate`.
- Repositories wrap `createBaseRepository()` where the table is a business
  record; workspace-scoped and soft-delete aware throughout.
- The saved-views filter tree must be plain JSON. Do not import a type from
  `packages/ui` — describe the shape in a comment and let the UI agent's
  exported type be reconciled at integration.
- Unit tests for each repository against the schema; no live database.
