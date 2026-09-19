# 08 — Tests & Coverage

Test volume is genuinely large. The gap is not quantity; it is **what the
tests do not assert** — specifically, the end-to-end wiring that the audit
found broken in `02` is covered by no test at all.

## 8.1 Numbers

| Area | Test files |
| --- | --- |
| `@yourcrm/crm` domain services | 75 |
| `@yourcrm/database` repositories | 35 |
| `apps/api` route modules | 42 |
| `apps/api` (middleware, app, openapi, health…) | 5 |
| `apps/worker` jobs | 7 |
| `apps/web` unit (lib/app/components) | 33 |
| `apps/web` Playwright e2e specs | 11 |
| other packages (auth, permissions, config, ui, testing, …) | 27 |

`bun run test` runs **1159 tests across 75 files** in `@yourcrm/crm` alone,
all passing, with meaningful assertions: permission denial paths, event
emission, audit rows, idempotency, and property-style invariants
(e.g. “an app cannot act outside its granted scopes”).

## 8.2 HIGH — nothing tests that the product is actually *wired*

The six inert features in `02` all pass their unit tests. That is the point:
each unit tests its local `defaultQueue()` stub or injected fake port, so
“the queue is a log line” and “the runner is unbound” are invisible to the
suite. The following have **no test**:

- That `apps/api/src/index.ts` calls the three missing boot subscriptions.
- That `apps/worker/src/index.ts` binds all six runner ports.
- That the public API-key middleware is mounted on the app.
- That every module file in `routes/modules/*.ts` is mounted in the generated
  registry (and the barrels are regenerated).

**Fix — a small “wiring” test suite** that would have caught all of `02`:
1. A test that constructs `createApp()` and asserts
   `Authorization: Bearer <key>` resolves to a session (mount guard).
2. A test that imports the worker bootstrap with spies and asserts each
   `register*` port was called.
3. A source-text/registry test asserting every module file with a `basePath`
   export appears in `moduleRoutes`, and every `packages/crm/src/*` dir is in
   the crm barrel.
4. A boot test asserting the three subscriptions are invoked.

These are cheap and hermetic (no DB/Redis needed) and close the largest
correctness risk in the repo.

## 8.3 HIGH — Playwright covers ~11 of ~37 modules

`AGENTS.md` requires “Playwright for primary workflows”. The 11 specs cover:
`smoke`, `settings`, `email`, `automation`, `sequences`, `marketing`,
`ai`, `ai-agents`, `ai-governance`, `conversation-intelligence`, `portal`.

**26 modules with a concrete UI have no e2e spec**, including the highest-traffic
ones: `people`, `companies`, `leads`, `deals`, `tasks`, `calendar`, `inbox`,
`calling`, `products`, `quotes`, `invoices`, `tickets`, `knowledge-base`,
`forms`, `reports`, `dashboards`, `search`, `import-export`, `integrations`,
`custom-objects`, `customer-success`, `marketplace`, `files`, `booking-links`,
`pipelines`, `notifications`, `api-webhooks`.

Also note `e2e.yml` runs with `continue-on-error: true` (“expected to be flaky
while auth is being built”) — so even the modules that do have specs cannot
red-block a PR. That comment is now stale (auth has shipped); the e2e job
should be made blocking.

## 8.4 MEDIUM — the deny path is the strongest tested thing (keep it)

Almost every service test asserts the denial case first (viewer cannot create,
member cannot delete, etc.). This is a strength and should be preserved as new
modules land. The audit found no service missing permission enforcement, which
is partly *because* the tests would fail loudly otherwise.

## 8.5 MEDIUM — tests are hermetic (good) but that hides integration bugs

`docs/conventions.md` mandates hermetic tests (“no live DB/Redis — stub
transports”). That is the right default, but it means nothing in CI ever
exercises a real Postgres/Redis/BullMQ path. The e2e job does spin up real
services, but it is non-blocking and only covers 11 specs.

**Fix:** keep hermetic unit tests, and add a small **integration suite** that
runs against the compose Postgres/Redis in CI for the critical paths: apply
migrations, run one automation job end to end, deliver one webhook, execute
one sequence step. Mark it separately from `bun test` so it can run in the
e2e job where services exist.

## 8.6 LOW — `apps/mobile` is untested and unchecked

Zero scripts, zero tests, and outside every pipeline (cross-ref `04.8`).

## Summary

| # | Severity | Item |
| --- | --- | --- |
| 8.1 | INFO | ~245 test files, 1159+ assertions passing in `@yourcrm/crm` |
| 8.2 | HIGH | No test asserts boot hooks, worker runner binding, or route mounts |
| 8.3 | HIGH | Playwright covers 11/37 modules; e2e job is non-blocking |
| 8.4 | INFO | Permission-denial coverage is strong |
| 8.5 | MEDIUM | Fully hermetic tests hide integration/queue bugs |
| 8.6 | LOW | `apps/mobile` untested/outside pipelines |
