import type { Context } from "hono"
import { getCookie } from "hono/cookie"
import { createMiddleware } from "hono/factory"
import type { AppEnv } from "../hono-env"
import {
  devSession,
  resolveSession,
  SESSION_COOKIE_NAME,
  type AuthStore,
  type Session,
} from "@yourcrm/auth"
import { getDb } from "@yourcrm/database"
// NOTE (wave-1 integration): `schema/auth.ts` is not yet re-exported from
// `@yourcrm/database`'s barrel (owned by the shared-tables agent this wave),
// so the store adapter imports it via subpath. The integrator replaces this
// with a barrel import; the function names are the contract.
import {
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
  type AuthDb,
} from "@yourcrm/database/src/schema/auth"

/**
 * Authentication middleware. Resolves the `yourcrm_session` cookie (or an
 * `Authorization: Bearer` token for API/MCP clients) into the stable
 * `Session` contract via `@yourcrm/auth` + the drizzle auth store, so
 * `requireSession()` and `/api/v1/me` see the real user.
 *
 * No session (or no reachable database, e.g. in unit tests) yields a null
 * session and protected routes return 401. `x-dev-session: 1` still yields
 * a test owner session outside production for parallel agents' local work.
 */

function toAuthStore(db: AuthDb): AuthStore {
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
    createUserWithWorkspace: () => {
      throw new Error("auth middleware store is read/resolve-only")
    },
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

function rawTokenFromRequest(c: Context<AppEnv>): string | null {
  const cookieToken = getCookie(c, SESSION_COOKIE_NAME)
  if (cookieToken) return cookieToken
  const header = c.req.header("authorization")
  if (header?.toLowerCase().startsWith("bearer ")) {
    const token = header.slice("bearer ".length).trim()
    return token || null
  }
  return null
}

export function auth(store?: AuthStore) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const env = process.env.NODE_ENV ?? "development"
    let session: Session | null = null

    const token = rawTokenFromRequest(c)
    if (token) {
      try {
        const active: AuthStore = store ?? toAuthStore(getDb())
        session = await resolveSession(active, token)
      } catch {
        // Unreachable DB / store failure: stay unauthenticated (401 downstream).
        session = null
      }
    }

    if (!session && env !== "production" && c.req.header("x-dev-session") === "1") {
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
