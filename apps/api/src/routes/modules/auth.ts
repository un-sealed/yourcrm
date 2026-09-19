import { zValidator } from "@hono/zod-validator"
import {
  AuthError,
  buildSessionCookie,
  clearSessionCookie,
  createLoginRateLimiters,
  loginSchema,
  loginUser,
  logoutUser,
  signupSchema,
  signupUser,
  SESSION_COOKIE_NAME,
  type AuthStore,
  type LoginRateLimiters,
  type Session,
} from "@yourcrm/auth"
import { getDb } from "@yourcrm/database"
// NOTE (wave-1 integration): `schema/auth.ts` is not yet re-exported from
// `@yourcrm/database`'s barrel (same gap `middleware/auth.ts` documents), so
// this module imports it via subpath. The integrator can drop this once the
// barrel is wired. Unlike the middleware's read-only adapter, signup needs
// `createUserWithWorkspace`, so this module builds its own full `AuthStore`.
import {
  createUserWithWorkspace,
  findSessionByTokenHash,
  findUserByEmail,
  findUserById,
  findWorkspaceBySlug,
  getCredential,
  insertSession,
  listMembershipsForUser,
  revokeSessionByTokenHash,
  touchLastLogin,
  touchSession,
} from "@yourcrm/database/src/schema/auth"
import { errorEnvelope } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { getCookie } from "hono/cookie"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * Auth module (spec 04-authentication, P0) — the HTTP layer over
 * `@yourcrm/auth`'s email+password service. All business logic (hashing,
 * tokens, rate limiting, generic login-failure messaging) lives in the
 * package; this file only binds it to Hono: zod validation at the boundary,
 * call the service, set/clear the session cookie, shared envelopes.
 *
 * Mounted at `/auth`, so routes land at `/api/v1/auth/{login,signup,logout,me}`
 * — the exact contract `apps/web/app/{login,signup}/page.tsx` already post to.
 */

export const basePath = "/auth"

export type AuthRouteDeps = {
  store?: AuthStore
  limiters?: LoginRateLimiters
}

/** Drizzle-backed `AuthStore`. Never called at factory time (see below). */
function defaultStore(): AuthStore {
  const db = getDb()
  return {
    findUserByEmail: async (email) => {
      const row = await findUserByEmail(db, email)
      return row ? { id: row.id, email: row.email, name: row.name } : null
    },
    findUserById: async (id) => {
      const row = await findUserById(db, id)
      return row ? { id: row.id, email: row.email, name: row.name } : null
    },
    listMembershipsForUser: async (userId) => {
      const rows = await listMembershipsForUser(db, userId)
      return rows.map((r) => ({
        workspaceId: r.workspaceId,
        userId: r.userId,
        role: r.role ?? "viewer",
      }))
    },
    findWorkspaceBySlug: async (slug) => {
      const row = await findWorkspaceBySlug(db, slug)
      return row ? { id: row.id } : null
    },
    getPasswordHash: async (userId) => {
      const row = await getCredential(db, userId)
      return row ? row.passwordHash : null
    },
    createUserWithWorkspace: (input) => createUserWithWorkspace(db, input),
    createSession: async (input) => {
      const row = await insertSession(db, input)
      return {
        id: row.id,
        userId: row.userId,
        workspaceId: row.workspaceId,
        tokenHash: row.tokenHash,
        expiresAt: row.expiresAt,
        lastUsedAt: row.lastUsedAt,
        userAgent: row.userAgent,
        revokedAt: row.revokedAt,
      }
    },
    findSessionByTokenHash: async (tokenHash) => {
      const row = await findSessionByTokenHash(db, tokenHash)
      return row
        ? {
            id: row.id,
            userId: row.userId,
            workspaceId: row.workspaceId,
            tokenHash: row.tokenHash,
            expiresAt: row.expiresAt,
            lastUsedAt: row.lastUsedAt,
            userAgent: row.userAgent,
            revokedAt: row.revokedAt,
          }
        : null
    },
    touchSession: async (id) => {
      await touchSession(db, id)
    },
    touchLastLogin: async (userId) => {
      await touchLastLogin(db, userId)
    },
    revokeSessionByTokenHash: async (tokenHash) => {
      await revokeSessionByTokenHash(db, tokenHash)
    },
  }
}

function callerIp(c: Context<AppEnv>): string {
  const forwarded = c.req.header("x-forwarded-for")
  const first = forwarded?.split(",")[0]?.trim()
  return first && first !== "" ? first : "unknown"
}

function requestMetaOf(c: Context<AppEnv>) {
  return { ip: callerIp(c), userAgent: c.req.header("user-agent") ?? null }
}

/** Shape returned to the client for login/signup/me: user + active workspace. */
function sessionPayload(session: Session) {
  return {
    user: session.user,
    workspaceId: session.workspaceId ?? null,
    memberships: session.memberships,
    expiresAt: session.expiresAt ?? null,
  }
}

/** Secure only in production: the demo/local flow runs over plain http. */
function setSessionCookie(c: Context<AppEnv>, token: string) {
  c.header(
    "set-cookie",
    buildSessionCookie(token, { secure: process.env.NODE_ENV === "production" }),
  )
}

/**
 * `AuthError.status` is already the right HTTP status for each failure
 * (see `packages/auth/src/service.ts`); this narrows it to the literal
 * union Hono's `c.json()` types require, defaulting unknown statuses to 400.
 */
function statusForAuthError(err: AuthError): 400 | 401 | 403 | 409 | 429 | 500 {
  switch (err.status) {
    case 401:
      return 401
    case 403:
      return 403
    case 409:
      return 409
    case 429:
      return 429
    case 500:
      return 500
    default:
      return 400
  }
}

function mapError(c: Context<AppEnv>, err: unknown) {
  const requestId = c.get("requestId") as string | undefined
  if (err instanceof AuthError) {
    return c.json(errorEnvelope(err.code, err.message, requestId), statusForAuthError(err))
  }
  throw err
}

export function createRoutes(deps: AuthRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  let cachedStore: AuthStore | null = deps.store ?? null
  const store = () => (cachedStore ??= defaultStore())
  // In-memory limiter state must persist across requests, not be rebuilt
  // per-request; it never touches the database so it is safe to build here.
  const limiters = deps.limiters ?? createLoginRateLimiters()

  app.post(
    "/login",
    zValidator("json", loginSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "Invalid request body",
            c.req.header("x-request-id") ?? undefined,
            result.error.flatten(),
          ),
          400,
        )
      }
    }),
    async (c) => {
      try {
        const result = await loginUser(store(), c.req.valid("json"), requestMetaOf(c), limiters)
        setSessionCookie(c, result.token)
        return c.json({ data: sessionPayload(result.session) })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/signup",
    zValidator("json", signupSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "Invalid request body",
            c.req.header("x-request-id") ?? undefined,
            result.error.flatten(),
          ),
          400,
        )
      }
    }),
    async (c) => {
      try {
        const result = await signupUser(store(), c.req.valid("json"), requestMetaOf(c))
        setSessionCookie(c, result.token)
        return c.json({ data: sessionPayload(result.session) }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE_NAME)
    await logoutUser(store(), token)
    c.header("set-cookie", clearSessionCookie())
    return c.json({ data: { loggedOut: true } })
  })

  app.get("/me", requireSession(), (c) => {
    const session = c.get("session") as Session
    return c.json({ data: sessionPayload(session) })
  })

  return app
}

export const openApiPaths = {
  "/api/v1/auth/login": {
    post: {
      summary: "Log in with email + password; sets the httpOnly session cookie",
      operationId: "authLogin",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(loginSchema) } },
      },
    },
  },
  "/api/v1/auth/signup": {
    post: {
      summary: "Create a user + workspace + owner membership, then log in",
      operationId: "authSignup",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(signupSchema) } },
      },
    },
  },
  "/api/v1/auth/logout": {
    post: {
      summary: "Revoke the current session server-side and clear the cookie",
      operationId: "authLogout",
    },
  },
  "/api/v1/auth/me": {
    get: { summary: "Current session (requires auth)", operationId: "authMe" },
  },
}
