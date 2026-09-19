# 04 — Architecture & Layering

The architecture boundaries from `AGENTS.md` / `docs/architecture.md` are
**respected**. The findings here are duplication, stale contract comments, and
hand-synced constants — the kind of drift that is invisible until two modules
disagree.

## 4.1 ✅ Verified — import direction is clean

- **No SQL outside `packages/database`.** A repo-wide search for
  `db.execute/select/insert/update/delete`, `sql\`` and Drizzle query building
  found exactly one legitimate exception: the readiness probe's
  `SELECT 1` in `apps/api/src/routes/health.ts:54`, which is a liveness check,
  not business SQL. Every other hit was a comment.
- **`@yourcrm/crm` imports neither Hono nor Next.js nor `@yourcrm/ui`.**
  Searching `packages/crm` for `from "hono"`, `from "next"` and `@yourcrm/ui`
  found only doc comments (e.g. `reports/schemas.ts` describing the shared
  filter encoding) — no actual imports.
- **Layering in route handlers** is correct: handlers validate → check session
  → call a domain service. `apps/api/src/routes/modules/people.ts` is the
  reference and every module mirrors it. Zero business logic in handlers.
- **Permissions are enforced server-side in the domain layer**, not just the
  route layer (`requirePermission()` is the first statement in service methods
  across all 40+ `packages/crm/src/**` modules).
- **AI consumes domain services, never tables.** The AI tool registry
  (`packages/crm/src/ai-assistant/tools.ts`) calls report/service functions
  and re-runs `requirePermission()` for the asking user.

## 4.2 MEDIUM — `@yourcrm/ai`'s real providers are duplicated inside `@yourcrm/crm`

`packages/ai/src/index.ts` documents the situation: the OpenAI-compatible and
stub providers "live in `packages/crm/src/ai-assistant/providers/`, written
against a **byte-identical structural mirror** of `AiProvider`", because
`packages/crm` does not declare `@yourcrm/ai` as a dependency. That leaves two
copies of the provider contract and two implementations that must be kept
identical by hand — exactly the "no duplicate foundations" rule in `AGENTS.md`.

Two sub-problems:
- **Stale claim.** The comment says `@yourcrm/ai` "is not a declared dependency
  of any app", but `apps/api/package.json` **does** declare `@yourcrm/ai`.
  Only `packages/crm` lacks it.
- **Drift risk.** A fix to one provider (e.g. the `reasoning_content` fix from
  `02.7`) must be applied in two places.

**Fix:** add `"@yourcrm/ai": "workspace:*"` to `packages/crm/package.json`,
delete the structural mirror, and import the real port. Until then, add a
source-text test asserting the two provider files are structurally identical
so drift fails CI instead of shipping.

## 4.3 MEDIUM — stale "wave-1 integration" workarounds and barrel docs

The database barrel now re-exports both schema and repositories:

```ts
// packages/database/src/index.ts
export * from "./schema"
export * from "./repositories"
```

…but three artifacts still claim it does not:

- `apps/api/src/middleware/auth.ts:24-29` — NOTE comment: "`schema/auth.ts` is
  not yet re-exported from `@yourcrm/database`'s barrel … the integrator
  replaces this with a barrel import."
- `apps/api/src/routes/modules/auth.ts:18-24` — the same NOTE.
- `packages/database/README.md` — "repositories are not barrelled … Import via
  subpath".

**Impact.** Every `apps/api` module imports repositories via the subpath
`@yourcrm/database/src/repositories/<x>-repository` (109 references repo-wide).
That works, but it bypasses the package's public surface and violates the
spirit of the import-boundary rules. New contributors follow the stale note
and add more subpath imports.

**Fix:** update the two NOTE comments and the README to say the barrel is the
public surface; optionally migrate `apps/api` imports to the barrel (mechanical
but broad — do it as its own PR with the generator).

## 4.4 MEDIUM — the filter model is restated in four places, one of them wrong

Documented in `docs/INTEGRATION-TODO.md` §4 and still true:

- `@yourcrm/ui`'s `FilterTree` is canonical.
- `@yourcrm/crm` and `@yourcrm/database` restate it structurally (they may not
  import UI — the restatement is architecturally forced).
- **`saved_views.filter` uses an older `{ op, conditions }` encoding** that
  does **not** match what `FilterBuilder` emits. Nothing depends on it yet,
  which is the only reason this is MEDIUM and not CRITICAL.

**Fix:** reconcile `saved_views` onto the builder encoding before anything
relies on it. A shared structural type in a neutral package (e.g.
`@yourcrm/validation`) would remove the drift risk for the restatements.

## 4.5 MEDIUM — `SEARCH_OBJECT_TYPES` is hand-synced across three files

`packages/database/src/schema/search.ts`, `packages/crm/src/search/types.ts`
and `apps/web/app/app/search/types.ts` must be edited together whenever a
module becomes searchable (Knowledge Base adding `"article"` touched all
three). Three copies of one contract is a latent drift bug.

**Fix:** define it once in a package both the domain and web can import
(e.g. `@yourcrm/validation`) and re-export.

## 4.6 MEDIUM — route→repository double-casts defeat the type seam

`input as unknown as Parameters<typeof repo.create>[2]` (and analogues) appear
across route modules — the pattern was established in `people.ts` (lines
“repository.create(db, workspaceId, input as unknown as CreatePersonInput, actorId)”)
and mirrored by every module. It defeats type-checking at exactly the seam
where the service input type and the repository input type could drift apart.

**Fix:** align the service and repository input types (or derive one from the
other) so the cast is unnecessary. This is the highest-value type-safety fix
in the repo.

## 4.7 LOW — `defaultEmailService()` composition is duplicated

`apps/api/src/routes/modules/sequences.ts` re-creates the private
`defaultService()` composition from `email.ts` because `email.ts` exports no
factory. Export one shared factory and delete the copy.

## 4.8 LOW — `@yourcrm/mobile` has no scripts and is outside every pipeline

`apps/mobile/package.json` declares no `typecheck`/`lint`/`test`. `turbo` never
touches it. That is intentional for a Phase-4 placeholder, but it means the
package is not even syntax-checked. A minimal `typecheck` script would keep the
reserved boundary honest at near-zero cost.

## 4.9 INFO — intentional boundaries that are correctly placeheld

- `packages/agents` is a Phase-3 placeholder (only depends on
  `@yourcrm/events`); the shipping agent runtime lives in
  `packages/crm/src/ai-agents` because it needs `@yourcrm/permissions` and
  `@yourcrm/crm` and agents may not edit `package.json`. Documented.
- `apps/mcp` must not import the database (enforced by a source-text test),
  so its ports are injected. Correct.
- Generated files (`packages/crm/src/index.ts`, `packages/database/src/schema/index.ts`,
  `apps/api/src/routes/modules/index.ts`) say "do not edit by hand" and are
  regenerated by `scripts/gen-barrels.ts` / `scripts/gen-routes.ts`. Correct
  and enforced by convention.

## Summary

| # | Severity | Item |
| --- | --- | --- |
| 4.1 | INFO | Layering verified clean (no SQL/Hono/UI leaks) |
| 4.2 | MEDIUM | `@yourcrm/ai` providers duplicated in `@yourcrm/crm` (+ stale comment) |
| 4.3 | MEDIUM | Stale barrel/"wave-1" notes; 109 subpath imports |
| 4.4 | MEDIUM | Filter model in 4 places; `saved_views` encoding mismatch |
| 4.5 | MEDIUM | `SEARCH_OBJECT_TYPES` hand-synced across 3 files |
| 4.6 | MEDIUM | Route→repo double-casts defeat type checking |
| 4.7 | LOW | `defaultEmailService()` duplicated |
| 4.8 | LOW | `apps/mobile` outside all pipelines |
| 4.9 | INFO | Placeholders correctly scoped and documented |
