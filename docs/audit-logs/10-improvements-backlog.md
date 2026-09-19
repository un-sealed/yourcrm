# 10 — Prioritized Backlog (Fixes & Improvements)

Everything above, ranked into a work order. Each item is one line with its
report reference. Do the **P0 block** first — those are correctness/security
items that block a credible "done" claim.

## P0 — do first (security & "the feature doesn't work")

1. **Fix the `x-dev-session` bypass** — gate it on an explicit default-off flag
   and require `NODE_ENV`. (`03.1`)
2. **Remove/require the default secrets** — `ENCRYPTION_KEY` default decrypts
   real provider credentials with a public key. (`03.2`)
3. **Mount public API-key auth** — one line in `app.ts`; keys authenticate
   nothing today. (`02.4`, `03.3`)
4. **Enqueue jobs for real** — add `bullmq` to `apps/api` and replace the six
   `defaultQueue()` stubs. (`02.1`)
5. **Register the six worker runner ports** in the worker bootstrap. (`02.2`)
6. **Add the three missing API boot subscriptions.** (`02.3`)
7. **Make CI green**: run `bun run format`, then un-mute e2e. (`01.5`, `09.1`)

## P1 — high value, low risk

8. **Fix navigation reachability** — link the 8+ orphaned modules; point the
   Analytics nav entry at `/app/dashboards`. (`07.2`, `07.3`)
9. **Replace the home-dashboard stub** (or redirect to `/app/dashboards`). (`07.4`)
10. **Add the wiring test suite** (boot hooks, runner binding, route mounts,
    barrel regeneration). This is what makes P0 items 4–6 stay fixed. (`08.2`)
11. **Route automation `notify` through notification preferences.** (`02.5`)
12. **Add the route/mount drift test** so an un-regenerated barrel fails CI
    instead of silently 404ing. (`06.5`)
13. **Fix the command palette** — Escape + focus trap + `aria-modal`, and
    either implement arrow-key nav or drop the hint. Wire or remove `+ Create`
    and the workspace switcher. (`07.6`)

## P2 — quality, consistency, correctness

14. **Collapse the duplicated `mapError`/validation hooks** into shared
    helpers. (`06.2`)
15. **Remove the route→repo double-casts** by aligning service and repository
    input types. (`04.6`, `06.3`)
16. **De-duplicate the AI provider contract** — depend `packages/crm` on
    `@yourcrm/ai`, delete the structural mirror. (`04.2`)
17. **Schema fixes before there is data**: `files.size_bytes` → BIGINT;
    standardize currency width. (`05.1`, `05.2`)
18. **Migration hygiene**: checksums in `schema_migrations`; decide a rollback
    convention; add the one ALTER-only cross-module FK migration. (`05.3`, `05.4`)
19. **Consolidate the hand-synced contracts**: `SEARCH_OBJECT_TYPES`,
    the filter model / `saved_views.filter` encoding. (`04.4`, `04.5`)
20. **Wire the portal magic-link transport and ticket reader**; add a rate
    limiter to magic-link requests. (`02.8`, `06.7`)
21. **Fix AI multi-step tool loops** (`reasoning_content` round-trip). (`02.7`)
22. **Expand Playwright coverage** to the high-traffic modules; then remove
    `continue-on-error`. (`08.3`)
23. **Add an integration suite** (migrations + one job of each kind) against
    real Postgres/Redis. (`08.5`)

## P3 — docs & polish

24. **Reconcile docs drift**: architecture.md OpenAPI text, database README,
    auth NOTE comments, portal header, and `INTEGRATION-TODO.md`. (`09.2`–`09.5`)
25. **Decide `SESSION_SECRET`'s fate** (remove or actually use it) and move all
    env docs in the same change. (`03.4`, `09.6`)
26. **Standardize loading/error files** across detail/form routes and document
    the chosen pattern. (`07.5`)
27. **Add an unauthenticated redirect** to `/login?next=…`. (`07.7`)
28. **Give `apps/mobile` a minimal `typecheck` script** so it is not entirely
    unchecked. (`04.8`)
29. **Gate `/api/v1/echo`** behind non-production, or remove it. (`06.6`)
30. **Add a `docs/README.md` index.** (`09.8`)

## Improvements worth considering (not defects)

- **Saved views are per-browser (`localStorage`).** Consider persisting them
  server-side (there is already a `saved_views` table) so a view follows the
  user across devices. (`07` context)
- **A reachability test** driven from `ALL_ROUTES` would make nav coverage a
  CI-enforced invariant rather than a manual audit. (`07.2`)
- **A single shared validation/error-hook module** in `apps/api/src/lib` would
  let a new module be ~30 lines shorter and impossible to get subtly wrong.
  (`06.2`)
- **Structured "not wired yet" startup banner**: log, at boot, which optional
  integrations are configured (AI, email, storage, queues). Silent no-ops
  (stub `defaultQueue`, unbound runners) are this codebase's dominant failure
  mode; a boot summary turns them into visible state. (`02`)
- **Provider-contract conformance test** (`packages/ai` vs the crm mirror)
  until the duplicate is removed. (`04.2`)

## Definition of "audit closed"

- `bun run format:check`, `typecheck`, `lint`, `test`, `build` all green.
- A key with `Authorization: Bearer ycrm_sk_…` authenticates on the running app.
- Enqueueing any of the six job kinds actually results in a completed job.
- Every concrete `page.tsx` is reachable from the nav (or explicitly allow-listed).
- The wiring test suite from item 10 exists and passes.
