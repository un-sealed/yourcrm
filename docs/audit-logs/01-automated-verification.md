# 01 — Automated Verification

Commands were run from the repo root on 2026-09-20 against a clean `main`
working tree. Exact results below; nothing is paraphrased.

## 1.1 Typecheck — ✅ PASS

```
bun run typecheck
# turbo run typecheck
# Tasks: 20 successful, 20 total  (FULL TURBO, cached)
```

All 20 configured workspaces typecheck with `tsc --noEmit`. No errors.

**INFO — `@yourcrm/mobile` is not in any pipeline.** `turbo run typecheck`
reports "Running typecheck in 21 packages" but only 20 tasks run. `apps/mobile`
declares no `typecheck`/`lint`/`test` scripts (`apps/mobile/package.json` has
only `name`, `version`, `private`). This is documented as intentional
(`apps/mobile/README.md`, `App.tsx`) — Phase 4. No action required now, but
note that `apps/mobile` is tracked by git and would not be checked by CI.

## 1.2 Lint — ✅ PASS

```
bun run lint
# turbo run lint
# Tasks: 20 successful, 20 total  (FULL TURBO, cached)
# eslint . --max-warnings=0
```

Zero warnings across all configured workspaces. `--max-warnings=0` is
enforced, so this is a real clean pass.

## 1.3 Tests — ✅ PASS

```
bun run test
# @yourcrm/crm:test:  1159 pass, 0 fail, 3168 expect() calls
# Ran 1159 tests across 75 files.
# Tasks: 20 successful, 20 total
```

No failures. The `@yourcrm/crm` suite is the largest and exercises permission
denial paths, event emission and audit rows per module.

## 1.4 Production web build — ✅ PASS

```
cd apps/web && bun run build
# ✓ compiled, ~70 routes emitted, First Load JS shared by all: 102 kB
```

The Next.js production build succeeds and emits every route, including
`/app/[section]` (dynamic), all module pages, the public `/book/[slug]`,
`/portal/*`, `/signup`, `/login`, `/onboarding`, `/unsubscribe`.

## 1.5 Format check — ❌ FAIL (HIGH)

```
bun run format:check
# [warn] ... (93 files)
# Code style issues found in 93 files. Run Prettier with --write to fix.
# error: script "format:check" exited with code 1
```

**Finding V-1 (HIGH): CI's first gate fails.** `.github/workflows/ci.yml`
runs `bun run format:check` as its very first check, before typecheck/lint/
test/build. With 93 prettier-dirty files, **CI is red on `main`**, and the
signal is masked: a real regression hidden behind a pre-existing format
failure is indistinguishable from the noise.

Affected areas include spec-pack markdown, several package READMEs, and —
importantly — source files that other agents touched:

```
packages/crm/src/ai-agents/{service.ts,service.test.ts}
packages/crm/src/import-export/{service.ts,service.test.ts}
packages/crm/src/invoices/{index.ts,service.ts,service.test.ts}
packages/crm/src/whatsapp/service.test.ts
packages/database/src/repositories/custom-objects-repository.test.ts
packages/database/src/repositories/{import-export,invoices}-repository.ts
```

**Fix:** run `bun run format` as its own commit, then re-run the full gate.
This was already flagged in `docs/INTEGRATION-TODO.md` §8 (then 79 files; it
has since grown to 93). Once green, add a pre-commit hook or make `format:check`
non-blocking only until it is.

## 1.6 What was NOT run

- **Playwright e2e** (`bun run test:e2e`) — requires live Postgres, Redis and
  both servers up; not run in this audit. Coverage of the specs themselves is
  assessed statically in `08-tests-and-coverage.md`.
- **Migration apply** (`bun run db:migrate`) — needs a live database. The
  migration set was reviewed statically (`05-data-and-migrations.md`).

## Baseline verdict

| Gate | Result |
| --- | --- |
| `typecheck` | ✅ pass |
| `lint` | ✅ pass |
| `test` | ✅ pass (1159 tests) |
| `build` (web) | ✅ pass |
| `format:check` | ❌ **fail — 93 files** |

The codebase is in good automated health except for the formatting gate. All
deeper issues in this audit (inert queues, unmounted auth, nav gaps) are
**not** caught by any automated gate, which is itself a finding: the
end-to-end wiring of background jobs and boot hooks has no test that would
notice if they were missing.
