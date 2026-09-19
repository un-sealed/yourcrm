import { Hono } from "hono"
import type { AppEnv } from "../hono-env"

/**
 * OpenAPI integration strategy: every domain route registers its zod
 * schemas here (Phase 1 generates the document from route registries).
 * Foundation serves a hand-written stub describing the versioned surface.
 */
export function openApiRoutes() {
  const app = new Hono<AppEnv>()

  app.get("/openapi.json", (c) =>
    c.json({
      openapi: "3.1.0",
      info: { title: "YourCRM API", version: "0.1.0" },
      servers: [{ url: "/api/v1" }],
      paths: {
        "/health": { get: { summary: "Liveness + dependency status", operationId: "health" } },
        "/api/v1/ping": { get: { summary: "Versioned liveness probe", operationId: "v1Ping" } },
        "/api/v1/echo": { post: { summary: "Validation-pattern example", operationId: "v1Echo" } },
        "/api/v1/me": { get: { summary: "Current session (requires auth)", operationId: "v1Me" } },
      },
    }),
  )

  return app
}
