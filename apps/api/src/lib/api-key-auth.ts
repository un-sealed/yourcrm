import { createMiddleware } from "hono/factory"
import type { Session, WorkspaceRole } from "@yourcrm/auth"
import type { ResolvedPublicApiKey } from "@yourcrm/crm/src/api-webhooks"
import type { AppEnv } from "../hono-env"

/**
 * Public API-key authentication (spec 32-api-webhooks, P0).
 *
 * WHY THIS IS A SEPARATE FILE
 * ---------------------------
 * `middleware/auth.ts` is owned by another concern, so this module does
 * not touch it. Instead it exposes the two pieces an integrator needs and
 * lets them decide where to attach:
 *
 *  - `sessionFromPublicApiKey()` / `resolvePublicApiKeySession()` — pure
 *    functions from a resolved key row to the SAME `Session` shape the
 *    cookie path produces;
 *  - `publicApiKeyAuth()` — a drop-in middleware that fills `c.set("session")`
 *    only when nothing else already has.
 *
 * WIRING (one line, in `apps/api/src/app.ts`, AFTER `app.use("*", auth())`):
 *
 * ```ts
 * app.use("*", publicApiKeyAuth())
 * ```
 *
 * Order matters and the middleware enforces it defensively: it never
 * overwrites a session the cookie path already established, so a browser
 * request cannot be downgraded to an API key's role by sending both.
 *
 * WHY THE SESSION SHAPE IS UNCHANGED
 * ----------------------------------
 * `requirePermission()` reads the role through `roleInWorkspace(session)`,
 * which reads `session.memberships`. A key therefore becomes a session
 * with exactly one membership — its workspace, at its role — and every
 * existing permission check applies to it unmodified. There is no
 * "API key" branch anywhere in the authorisation path, so there is no
 * second policy to keep in step and nothing for a key to bypass. A
 * `viewer` key is denied a write by the same line of code that denies a
 * viewer's browser session.
 */

export type PublicApiKeyResolver = (rawKey: string) => Promise<ResolvedPublicApiKey | null>

const WORKSPACE_ROLES: readonly WorkspaceRole[] = ["owner", "admin", "member", "viewer"]

/**
 * Narrow the stored role string. An unrecognised value degrades to
 * `viewer` rather than throwing: a row that somehow holds a bad role must
 * fail closed (least privilege), not fail open and not 500 the request.
 */
function toWorkspaceRole(role: string): WorkspaceRole {
  return WORKSPACE_ROLES.includes(role as WorkspaceRole) ? (role as WorkspaceRole) : "viewer"
}

/** Extract the raw credential from an `Authorization: Bearer …` header. */
export function bearerTokenFrom(header: string | null | undefined): string | null {
  if (!header) return null
  if (!header.toLowerCase().startsWith("bearer ")) return null
  const token = header.slice("bearer ".length).trim()
  return token === "" ? null : token
}

/**
 * Build the session a key acts as.
 *
 * `user.id` is the key's ISSUER when there is one, so audit rows point at
 * a real person (and `audit_events.actor_id` is a uuid column, which a
 * synthetic `apikey:…` string would violate). It falls back to the key's
 * own id — also a uuid — when the issuer is gone. `user.name` says plainly
 * that the actor is a key, so an audit reader is never misled into
 * thinking the human was at a keyboard.
 */
export function sessionFromPublicApiKey(key: ResolvedPublicApiKey): Session {
  const role = toWorkspaceRole(key.role)
  const actorId = key.createdBy ?? key.id
  return {
    user: {
      id: actorId,
      email: `${key.id}@api-key.invalid`,
      name: `API key: ${key.name}`,
    },
    memberships: [{ workspaceId: key.workspaceId, role }],
    workspaceId: key.workspaceId,
    ...(key.expiresAt === null ? {} : { expiresAt: key.expiresAt.toISOString() }),
  }
}

/**
 * Resolve a presented bearer token to a session, or null.
 *
 * Null covers every failure identically — not a key, unknown key, revoked,
 * expired, resolver unreachable — so a caller learns nothing from the
 * difference and a broken database cannot authenticate anyone.
 */
export async function resolvePublicApiKeySession(
  rawToken: string | null,
  resolve: PublicApiKeyResolver,
): Promise<Session | null> {
  if (!rawToken) return null
  try {
    const key = await resolve(rawToken)
    return key ? sessionFromPublicApiKey(key) : null
  } catch {
    return null
  }
}

/**
 * Middleware: authenticate `Authorization: Bearer <api key>` when no
 * session is present yet. Never overwrites an existing session.
 */
export function publicApiKeyAuth(deps: { resolve: PublicApiKeyResolver }) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.get("session")) {
      await next()
      return
    }
    const session = await resolvePublicApiKeySession(
      bearerTokenFrom(c.req.header("authorization")),
      deps.resolve,
    )
    if (session) c.set("session", session)
    await next()
  })
}
