# YourCRM Audit Logs

**Audit date:** 2026-09-20
**Auditor:** Buffy (automated code agent)
**Commit base:** `main` (clean working tree, `.env` gitignored)
**Scope:** entire monorepo — `apps/*` and `packages/*`, plus product specs under
`docs/yourcrm-agent-spec-pack/`.

This folder records what was checked, what was found, and what to do about it.
Every finding names the file it lives in; nothing here is a mystery or a
guess. Where a claim is a guess it is marked as such.

## How to read this

Each report uses the same severity legend:

| Tag | Meaning |
| --- | --- |
| **CRITICAL** | A shipped feature does not work, or a security/data problem exists. Fix before calling the module done. |
| **HIGH** | Correctness, layering, or contract problem with real user/operator impact. |
| **MEDIUM** | Quality, robustness, or consistency issue. |
| **LOW** | Polish, documentation, or optional improvement. |
| **INFO** | Verified-OK note or a documented, intentional deferral. |

## Reports

| File | Covers |
| --- | --- |
| [`01-automated-verification.md`](./01-automated-verification.md) | typecheck / lint / test / build / format results for the whole repo |
| [`02-critical-functional-gaps.md`](./02-critical-functional-gaps.md) | Features that are wired but inert (queues, boot hooks, API-key auth) |
| [`03-security-and-auth.md`](./03-security-and-auth.md) | Auth, sessions, dev-session bypass, SSRF, secrets |
| [`04-architecture-and-layering.md`](./04-architecture-and-layering.md) | Import direction, duplication, boundary contracts |
| [`05-data-and-migrations.md`](./05-data-and-migrations.md) | Schema, migrations, FK strategy, column types |
| [`06-api-layer.md`](./06-api-layer.md) | Route conventions, validation, permissions, envelopes, OpenAPI |
| [`07-web-ui-pages.md`](./07-web-ui-pages.md) | Per-route inventory + page-level findings |
| [`08-tests-and-coverage.md`](./08-tests-and-coverage.md) | Unit/integration/e2e coverage vs. the project's own rules |
| [`09-docs-and-operations.md`](./09-docs-and-operations.md) | Docs drift, runbook, CI |
| [`10-improvements-backlog.md`](./10-improvements-backlog.md) | Prioritized fix list (the actionable summary) |

## Method

1. **Automated gate first** — ran `bun run typecheck`, `bun run lint`,
   `bun run test`, `bun run format:check`, and a production `next build` to
   establish a factual baseline (`01`).
2. **Structural sweep** — scripted the web route tree for missing
   `loading.tsx` / `error.tsx`, cross-checked the API module registry against
   the web nav, and enumerated migrations vs. schema files (`05`, `06`, `07`).
3. **Contract checks** — grepped for layering violations (SQL outside
   `packages/database`, Hono/UI imports in domain packages), permission
   coverage, event constants, and duplicated foundations (`04`).
4. **Known-debt reconciliation** — the repo ships a detailed
   `docs/INTEGRATION-TODO.md`. Every open item there was re-verified against
   current `main` so this audit reflects reality, not the TODO's original
   snapshot (`02`, `03`).
5. **Targeted reading** — read the reference module (`people`), the route
   registry, the auth middleware, the app shell, and representative list/detail
   pages end to end.

## Headline summary

- The foundation is **solid**: all 1,159 unit tests pass, typecheck and lint
  are clean, the web app builds, and the layering rules are respected.
- **CI is currently red on one gate**: `format:check` fails on 93 files
  (`01`). This is the first step of `ci.yml`.
- **Six features are functionally inert** because background jobs are not
  enqueued (API has no `bullmq` dependency) and worker runners are never
  registered: automation, sequences, marketing campaigns, ai-agents,
  api-webhooks delivery, conversation-intelligence (`02`). This is the single
  largest impact item.
- **Public API-key auth is not mounted**, so `Authorization: Bearer ycrm_sk_…`
  authenticates nothing (`02`, `03`).
- Navigation and reachability gaps leave several fully-built modules
  unreachable from the UI (marketing, customer-success, sequences,
  booking-links, files, marketplace, dashboards, pipelines) and one nav link
  (`/app/analytics`) points at a placeholder (`07`).
- Unit coverage is strong (75 files in `@yourcrm/crm` alone) but **Playwright
  coverage is thin** — 11 specs against ~30 modules (`08`).
