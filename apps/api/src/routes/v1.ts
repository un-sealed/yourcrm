import { Hono } from "hono"
import type { AppEnv } from "../hono-env"
import { moduleRoutes } from "./modules/index"

/**
 * API v1 router. Versioning strategy: URL prefix (`/api/v1`). Breaking
 * changes ship as `/api/v2` alongside v1 — never mutate a shipped version.
 *
 * MODULE REGISTRY: module routers live in `routes/modules/<slug>.ts` and are
 * mounted here from the generated `moduleRoutes` list. Module agents add
 * files and run `scripts/gen-routes.ts` — they never edit this file.
 *
 * LAYERING: handlers validate -> check auth/permissions -> call domain
 * services. No business logic lives here (services land in @yourcrm/crm).
 */
export function v1Routes() {
  const app = new Hono<AppEnv>()

  for (const mod of moduleRoutes) {
    app.route(mod.path, mod.createRoutes())
  }

  return app
}
