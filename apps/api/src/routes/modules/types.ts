import type { Hono } from "hono"
import type { AppEnv } from "../../hono-env"

/**
 * Module-router contract. Every file in `routes/modules/<slug>.ts` exports:
 *
 * - `basePath` — mount point inside v1 (e.g. `"/"` or `"/deals"`).
 * - `createRoutes()` — factory returning a `Hono<AppEnv>` sub-app with
 *   routes relative to `basePath`. No business logic in handlers: validate
 *   -> check auth/permissions -> call domain services.
 * - `openApiPaths` (optional) — full `/api/v1/...` path entries merged into
 *   `/openapi.json` by `routes/openapi.ts`.
 *
 * `scripts/gen-routes.ts` regenerates `routes/modules/index.ts` from the
 * directory listing, so module agents only add files — they never edit
 * `routes/v1.ts`.
 */
export type ModuleDefinition = {
  path: string
  createRoutes: () => Hono<AppEnv>
  openApiPaths?: Record<string, Record<string, unknown>>
}
