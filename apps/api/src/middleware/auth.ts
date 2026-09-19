import { createMiddleware } from "hono/factory"
import type { AppEnv } from "../hono-env"
import { devSession, type Session } from "@yourcrm/auth"

/**
 * Authentication integration point. Phase 1 wires the real session provider
 * (Better Auth + OAuth) here; route handlers only read `c.get("session")`.
 *
 * Foundation behavior: no session cookie is recognized yet, so protected
 * routes return 401. `x-dev-session: 1` yields a test owner session for
 * local development only (never in production).
 */
export function auth() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const env = process.env.NODE_ENV ?? "development"
    let session: Session | null = null

    // TODO(phase-1/auth): resolve Better Auth session from request headers.
    if (env !== "production" && c.req.header("x-dev-session") === "1") {
      session = devSession()
    }

    c.set("session", session)
    await next()
  })
}

/** Guard for protected routes: 401 when no session is present. */
export function requireSession() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const session = c.get("session") as Session | null
    if (!session) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required",
            requestId: c.get("requestId"),
          },
        },
        401,
      )
    }
    await next()
  })
}
