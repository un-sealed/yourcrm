/**
 * Auth foundation. The real session provider (Better Auth / OAuth / SAML)
 * is wired in Phase 1 (spec 04-authentication). Until then this package
 * defines the stable `Session` contract every consumer codes against, plus
 * test helpers so API/MCP agents can develop without a live IdP.
 */

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer"

export type SessionUser = {
  id: string
  email: string
  name?: string
}

export type SessionMembership = {
  workspaceId: string
  role: WorkspaceRole
}

export type Session = {
  user: SessionUser
  memberships: SessionMembership[]
  /** Active workspace for the current request. */
  workspaceId?: string
  expiresAt?: string
}

export class UnauthorizedError extends Error {
  readonly code = "UNAUTHORIZED"
  constructor(message = "Authentication required") {
    super(message)
    this.name = "UnauthorizedError"
  }
}

/** Resolve the active workspace or throw — every scoped route uses this. */
export function requireWorkspace(session: Session | null): string {
  if (!session) throw new UnauthorizedError()
  if (!session.workspaceId) throw new UnauthorizedError("No active workspace")
  return session.workspaceId
}

/** Resolve the caller's role in the active workspace (defaults to viewer). */
export function roleInWorkspace(session: Session | null): WorkspaceRole {
  if (!session?.workspaceId) return "viewer"
  return session.memberships.find((m) => m.workspaceId === session.workspaceId)?.role ?? "viewer"
}

/** Test/dev helper: build a session without an IdP. */
export function devSession(overrides: Partial<Session> = {}): Session {
  return {
    user: { id: "user_dev", email: "dev@yourcrm.local" },
    memberships: [{ workspaceId: "ws_dev", role: "owner" }],
    workspaceId: "ws_dev",
    ...overrides,
  }
}
