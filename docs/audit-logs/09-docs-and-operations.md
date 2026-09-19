# 09 — Documentation & Operations

The repo is unusually well-documented for its size: a full spec pack, an
architecture page, a conventions page, an operations runbook, an integration
TODO, infrastructure notes, per-package READMEs and agent prompts. The problem
is **drift**: several docs describe an earlier state and now contradict the
code, which is worse than a missing doc because a maintainer trusts it.

## 9.1 HIGH — CI is red (format gate) and its e2e signal is muted

- `.github/workflows/ci.yml` runs `bun run format:check` first, and that gate
  fails on 93 files (`01.5`). Regardless of everything else, **CI does not
  pass on `main`**.
- `.github/workflows/e2e.yml` sets `continue-on-error: true` with the comment
  “Auth is being built in parallel this week, so these are expected to be
  flaky.” Auth has shipped; the comment is stale and the flag means Playwright
  regressions cannot block a PR.

**Fix:** run `bun run format` (own commit), then remove `continue-on-error`
from the e2e job.

## 9.2 MEDIUM — `docs/architecture.md` understates OpenAPI

The doc says: “OpenAPI: stub at `/openapi.json` today; Phase 1 generates from
route zod registries.” In reality `apps/api/src/openapi/document.ts` **already
generates a real OpenAPI 3.1 document** from every module's `openApiPaths`
(verified in `06.1`).

**Fix:** update the sentence to describe the shipped generator.

## 9.3 MEDIUM — `packages/database/README.md` documents a barrel that now exists

The README (People tables section) says “Import via subpath (repositories are
not barrelled)”, but `packages/database/src/index.ts` re-exports both schema
and repositories. Cross-ref `04.3`; the same stale claim appears as “wave-1
integration” NOTE comments in `apps/api/src/middleware/auth.ts` and
`apps/api/src/routes/modules/auth.ts`.

**Fix:** update the README and both NOTE comments; decide whether the public
surface is the barrel or the subpath and state it once.

## 9.4 MEDIUM — `docs/INTEGRATION-TODO.md` is out of date and misleading

The TODO is a valuable artifact but several entries no longer match reality:

- §7 says “**43 notifications** — table and contract exist; no module, no
  delivery.” The notifications module now exists (API router, web page,
  realtime hub, `subscribeNotificationsRealtimeDispatcher` wired at boot,
  notification bell, preferences page). This entry is stale.
- §7 “32 api-webhooks” and §2 event-constant groups are partially resolved.
- §1 duplicates items this audit re-verified as still open (`02`).

**Fix:** reconcile the TODO against `main` (or fold it into this audit folder)
and add a “last verified: <date>” line at the top so readers know how fresh it
is. Prefer a single source of truth: keep open items here, move closed ones out.

## 9.5 MEDIUM — stale “not mounted yet” comment on the portal router

`apps/api/src/routes/modules/portal.ts` header claims the router is not in the
generated registry. It is (cross-ref `06.4`). Remove the paragraph.

## 9.6 LOW — `.env.example` / docs alignment

`README.md` and `.env.example` document the env vars the app validates. Two
notes for whoever fixes `03.2`/`03.4`:
- If `SESSION_SECRET` is removed (it is unused), update `.env.example`,
  `infrastructure/README.md`, `docs/getting-started.md`, the spec-pack excerpt
  and `docker-compose.prod.yml` in the same change.
- If secrets become required (no defaults), make `.env.example` make that
  explicit so the quickstart still works.

## 9.7 ✅ Verified — operations story is strong

- `docs/operations.md` is a real runbook: liveness vs readiness semantics,
  Prometheus metric names, correlation IDs end to end, a **tested** backup/
  restore procedure (with the exact caveats found during that test), and a
  “start here when it’s broken” checklist. This is better than most projects.
- Health/readiness/metrics are implemented and documented consistently, with
  intentional limits stated (storage check is config-level; worker health is
  observed via logs/queue depth). `METRICS_ENABLED` gates `/metrics` off by
  default — correct.
- Backup/restore scripts exist under `infrastructure/backup/` and enforce
  restore-into-scratch-targets unless `RESTORE_LIVE=1`.
- Observability assets (`prometheus.yml`, `rules.yml`, `grafana-dashboard.json`)
  exist under `infrastructure/observability/`.
- `.env` is gitignored and confirmed untracked; `.env.example` is the
  documented template.

## 9.8 LOW — missing index for the docs

`docs/` has many files but no index besides the README at the repo root. With
this audit folder added, consider a `docs/README.md` linking
`getting-started`, `architecture`, `conventions`, `operations`,
`INTEGRATION-TODO`, `audit-logs/`, and the spec pack.

## Summary

| # | Severity | Item |
| --- | --- | --- |
| 9.1 | HIGH | CI red (format gate); e2e non-blocking with stale comment |
| 9.2 | MEDIUM | `architecture.md` calls OpenAPI a stub (it is real) |
| 9.3 | MEDIUM | Database README + auth NOTE comments describe a pre-barrel state |
| 9.4 | MEDIUM | `INTEGRATION-TODO.md` out of date (e.g. notifications entry) |
| 9.5 | MEDIUM | Portal “not mounted yet” comment is false |
| 9.6 | LOW | Env docs must move with the `SESSION_SECRET`/secrets decision |
| 9.7 | INFO | Operations runbook, health checks, backups are strong |
| 9.8 | LOW | No `docs/README.md` index |
