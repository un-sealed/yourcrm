# Scripts

Generator scripts owned by the platform-seams agent. Run them with Bun
directly (no install step — every dependency is already in the repo).

## `gen-routes.ts` — API module registry

Scans `apps/api/src/routes/modules/` and regenerates the checked-in manifest
`apps/api/src/routes/modules/index.ts` (the `moduleRoutes` list mounted by
`apps/api/src/routes/v1.ts`).

```bash
bun run scripts/gen-routes.ts          # regenerate
bun run scripts/gen-routes.ts --check  # CI: fail if the manifest is stale
```

Module-file contract for downstream agents (`routes/modules/<slug>.ts`):

- `export const basePath` — mount point inside v1 (`"/"` or `"/deals"`).
- `export function createRoutes()` — factory returning a `Hono<AppEnv>`
  sub-app. No business logic in handlers.
- `export const openApiPaths` (optional) — full `/api/v1/...` path entries
  merged into `/openapi.json`.

Files missing `basePath`/`createRoutes` are skipped with a warning.
`types.ts`, `index.ts` and `*.test.ts` are never treated as modules.
A generated manifest is used instead of runtime filesystem globbing because
Bun cannot reliably glob inside a built bundle — explicit beats clever.

## `gen-barrels.ts` — conflict-free barrel files

Regenerates the two barrels every module agent touches:

- `packages/crm/src/index.ts`
- `packages/database/src/schema/index.ts`

```bash
bun run scripts/gen-barrels.ts          # regenerate both barrels
bun run scripts/gen-barrels.ts --check  # CI: fail on drift
```

Only the relative `export * from "./..."` lines are rewritten (sorted,
deduplicated, top-level siblings only — `index.ts`, `*.test.ts`, `*.d.ts`
excluded). All other lines (doc comments, constants, types) are preserved
byte-for-byte. Workflow: module agents add their files freely; the
integrator runs this script after each merge instead of hand-resolving
barrel conflicts.

## Wiring (`gen:routes` / `gen:barrels`)

These scripts are intended to be wired as root scripts:

```json
{
  "scripts": {
    "gen:routes": "bun run scripts/gen-routes.ts",
    "gen:barrels": "bun run scripts/gen-barrels.ts"
  }
}
```

The `package.json` edit is left to the integrator: editing any
`package.json` is outside the platform-seams agent's scope.
