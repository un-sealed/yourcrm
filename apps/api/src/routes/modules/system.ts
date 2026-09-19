import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Session } from "@yourcrm/auth"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * System module — the worked example for the module-registry seam.
 * Mounted at `/` inside v1, so its routes keep their shipped paths:
 * `/api/v1/ping`, `/api/v1/echo`, `/api/v1/me`.
 */

export const basePath = "/"

const echoSchema = z.object({
  message: z.string().min(1).max(1000),
})

export function createRoutes() {
  const app = new Hono<AppEnv>()

  // Public liveness probe for the versioned surface.
  app.get("/ping", (c) => c.json({ data: { pong: true, version: "v1" } }))

  // Validation pattern: zod schema at the boundary, envelope errors.
  app.post(
    "/echo",
    zValidator("json", echoSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "Invalid request body",
              requestId: c.req.header("x-request-id") ?? undefined,
              details: result.error.flatten(),
            },
          },
          400,
        )
      }
    }),
    (c) => {
      const body = c.req.valid("json")
      return c.json({ data: { echo: body.message } })
    },
  )

  // Auth-gated example: proves the session integration point (401 today).
  app.get("/me", requireSession(), (c) => {
    const session = c.get("session") as Session
    return c.json({ data: { user: session.user, workspaceId: session.workspaceId } })
  })

  return app
}

export const openApiPaths = {
  "/api/v1/ping": { get: { summary: "Versioned liveness probe", operationId: "v1Ping" } },
  "/api/v1/echo": {
    post: {
      summary: "Validation-pattern example",
      operationId: "v1Echo",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(echoSchema) } },
      },
    },
  },
  "/api/v1/me": { get: { summary: "Current session (requires auth)", operationId: "v1Me" } },
}
