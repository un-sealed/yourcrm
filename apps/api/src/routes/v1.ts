import { Hono } from "hono"
import type { AppEnv } from "../hono-env"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Session } from "@yourcrm/auth"
import { requireSession } from "../middleware/auth"

/**
 * API v1 router. Versioning strategy: URL prefix (`/api/v1`). Breaking
 * changes ship as `/api/v2` alongside v1 — never mutate a shipped version.
 *
 * LAYERING: handlers validate -> check auth/permissions -> call domain
 * services. No business logic lives here (services land in @yourcrm/crm).
 */

const echoSchema = z.object({
  message: z.string().min(1).max(1000),
})

export function v1Routes() {
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
