# 05 — Data Model & Migrations

44 migrations (`packages/database/migrations/0000…0410`) mirror 48 schema
files. The pattern is consistent: every table spreads the `BaseRecord`
contract (id, workspace_id, timestamps, created/updated by, soft-delete), the
runner is transaction-safe, and modules document their "guarantees that live
in the database" (idempotency indexes, CHECK bounds, append-only triggers).
The findings below are the ones worth fixing **before there is real data**.

## 5.1 MEDIUM — `files.size_bytes` is `INTEGER` (2 GB ceiling)

`packages/database/migrations/0100_files.sql:23`:

```sql
size_bytes INTEGER NOT NULL DEFAULT 0,
```

`INTEGER` caps at ~2.1 GB. This is an S3/MinIO-backed file module; a single
large file (or a future video/backup upload) overflows. It should be `BIGINT`.

**Fix:** additive migration altering the column to `BIGINT`. Cheap now, a
migration-and-backfill later.

## 5.2 MEDIUM — currency column widths are inconsistent

```
0001_foundation.sql:16  currency VARCHAR(8)   -- workspaces
0040_deals.sql:25       currency VARCHAR(3)   -- deals
0080_products.sql:40    currency VARCHAR(3)   -- product_prices
0130_quotes.sql:29      currency VARCHAR(8)   -- quotes
0140_invoices.sql:26,71 currency VARCHAR(8)   -- invoices, payments
```

A 3-char column cannot hold a non-ISO-4217 or future multi-char currency code,
and the inconsistency means the same logical value has two different shapes.
Pick one width (8 is the safer choice) and align all five via additive
`ALTER TABLE … TYPE VARCHAR(8)`.

## 5.3 MEDIUM — `0040_deals.sql` runs before `0050_pipelines.sql`, so deals can never FK pipelines

`0040_deals.sql:4-5` documents it explicitly: `pipeline_id`/`stage_id` are
plain uuid columns **with no foreign keys** because the pipelines tables are
created later in `0050_pipelines.sql`.

**Impact.** Referential integrity for a core relationship is only enforced in
application code. A deleted pipeline leaves dangling deal references.

**Fix:** when the modules are frozen, add one **ALTER-only integration
migration** that adds the missing FKs after all tables exist (this is the same
"cross-module FK integration pass" noted for every module — see 5.5).

## 5.4 MEDIUM — no down/rollback migrations

`AGENTS.md` requires migrations that are "additive, reversible where
practical". A search of all 44 migrations found **zero** down/rollback
sections. The runner (`packages/database/src/migrate.ts`) is forward-only and
records only filenames.

**Impact.** Rolling back a bad schema change requires hand-writing a new
migration under pressure. There is also **no checksum verification**: editing
an already-applied migration file silently does nothing on existing databases
and produces a different schema on fresh ones — a classic drift trap.

**Fix:**
1. Record a content checksum alongside the filename in `schema_migrations` and
   refuse to run if an applied file changed.
2. Adopt a convention for reversible migrations (paired `-- down` sections or
   a sibling `<name>.down.sql`) for at least destructive changes.

## 5.5 INFO — cross-module references are plain uuids by design

Every module uses plain, indexed uuid columns for references into another
module's tables (companies, memberships, people from other modules, etc.).
This is deliberate (modules were built in parallel) and documented. The
trade-off is no DB-level referential integrity across modules. The single
"cross-module FK integration pass" (one ALTER-only migration once all tables
exist) is the planned remedy and remains open.

## 5.6 INFO — known schema gotchas

- **`form_submissions."values"` is a PostgreSQL reserved word** and must stay
  quoted in any hand-written SQL (`0090_forms.sql:46` region). Automated
  schema tooling handles it; humans must remember.
- **`audit_events` is append-only at the DB level** — `0320_settings.sql`
  installs a trigger rejecting UPDATE/DELETE/TRUNCATE. Verified: nothing in
  the codebase mutates audit rows. This is a strong property; keep it.
- **`ai_policies` default is `require_approval`** — the deny-by-human default
  lives in the DDL, not just the service layer. Correct.
- **Duplicate/tie-out:** the schema barrel exports all 47 schema modules and
  the repositories barrel exports all repositories. Verify the barrels are
  regenerated after every merge (`bun run scripts/gen-barrels.ts`) — an
  unregenerated barrel makes a module's tables invisible.

## 5.7 LOW — migration slot numbering is non-contiguous by design

Slots jump (e.g. `0380` → `0400`; `0003` → `0010`). This reserves integer
space for parallel agents to insert modules without renumbering. It is a
deliberate convention, not a gap — noted so a future auditor does not mistake
it for missing migrations.

## Summary

| # | Severity | Item | Fix |
| --- | --- | --- | --- |
| 5.1 | MEDIUM | `files.size_bytes` INTEGER | `ALTER … BIGINT` |
| 5.2 | MEDIUM | Currency widths `VARCHAR(3)` vs `(8)` | standardize on `VARCHAR(8)` |
| 5.3 | MEDIUM | deals→pipelines FK impossible (ordering) | ALTER-only integration migration |
| 5.4 | MEDIUM | No down migrations; no checksum guard | add checksums + rollback convention |
| 5.5 | INFO | Cross-module refs are plain uuids (by design) | single FK pass later |
| 5.6 | INFO | Reserved word, append-only audit, deny-by-default | none |
| 5.7 | INFO | Non-contiguous slot numbering (intentional) | none |
