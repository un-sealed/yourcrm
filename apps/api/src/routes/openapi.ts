import { Hono } from "hono"
import type { AppEnv } from "../hono-env"
import { buildOpenApiDocument } from "../openapi/document"

/**
 * OpenAPI integration strategy: every module router registers its zod-derived
 * schemas via `openApiPaths` in `routes/modules/<slug>.ts`; this route serves
 * the assembled document. Module agents never edit this file.
 */
export function openApiRoutes() {
  const app = new Hono<AppEnv>()

  app.get("/openapi.json", (c) => c.json(buildOpenApiDocument()))

  return app
}
