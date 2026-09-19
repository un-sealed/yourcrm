# Wave 1 — CI/CD Agent

Branch: `agent/ci-cd`

`MASTER-ROADMAP.md` lists CI/CD as a Phase 0 foundation item and it was never
built — there is no `.github` directory at all. Eleven agents are about to
open eleven branches with no automated gate on any of them.

Spec: `docs/yourcrm-agent-spec-pack/00-project-initialization.md`

## You own, exclusively

```text
.github/**
```

**Nothing else.** Not `package.json` (the scripts you need already exist),
not the Dockerfile, not `docker-compose.yml`, not any source file. Another
agent owns Docker this wave.

## Build

1. **`ci.yml`** — on push and pull_request:
   - `oven-sh/setup-bun`, matching the `packageManager` pin in `package.json`
   - cache Bun's install cache **and** the Turborepo cache keyed on lockfile
     plus `turbo.json`
   - `bun install --frozen-lockfile`
   - then `bun run format:check`, `typecheck`, `lint`, `test`, `build`
   - run them as separate named steps, not one chained command, so a failure
     is legible at a glance in the checks UI
2. **`migrations.yml`** — spin up `postgres` (with pgvector) and `redis` as
   services, run `bun run db:migrate`, then `bun run db:seed`. This is the
   gate that catches two agents claiming the same migration slot — make the
   failure message say so explicitly.
3. **`e2e.yml`** — Playwright against live web + API. A Playwright config and
   a smoke spec already exist at `apps/web/playwright.config.ts` and
   `apps/web/e2e/smoke.spec.ts`; wire them up, boot the servers, upload the
   report as an artifact. Mark it `continue-on-error: true` for now — auth is
   still being built in parallel and these will be flaky this week.
4. **`pr.yml`** — enforce the `AGENTS.md` review checklist mechanically where
   possible: fail if a PR touches more than one module's directory, if it
   modifies `bun.lock` or any `package.json`, or if it adds `eslint-disable`,
   `@ts-ignore` or `.skip(`. These are exactly the shortcuts a weak model
   reaches for; catching them in CI is cheaper than catching them in review.
5. A short `.github/pull_request_template.md` mirroring the `AGENTS.md`
   completion checklist.

## Rules

- Pin every action to a major version tag.
- Never put a secret in a workflow file. Reference `secrets.*`.
- Workflows must pass on the current `main` as it stands today. If a gate
  cannot pass yet because the feature is unbuilt, mark that job
  `continue-on-error` and say so in your report — do not delete the check and
  do not weaken the command to make it green.
- Concurrency group per branch so pushes cancel superseded runs; with a dozen
  agents pushing this matters.
