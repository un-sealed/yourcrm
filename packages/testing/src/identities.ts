import type { Session, SessionMembership, SessionUser, WorkspaceRole } from "@yourcrm/auth"
import { nextId } from "./time"

export type TestWorkspace = {
  id: string
  name: string
}

/** Workspace fixture with a deterministic id. Override any field. */
export function makeWorkspace(overrides: Partial<TestWorkspace> = {}): TestWorkspace {
  const id = overrides.id ?? nextId("ws")
  return { id, name: `Workspace ${id}`, ...overrides }
}

/** User fixture with a deterministic id and example email. Override any field. */
export function makeUser(overrides: Partial<SessionUser> = {}): SessionUser {
  const id = overrides.id ?? nextId("user")
  return { id, email: `${id}@example.com`, ...overrides }
}

/** Membership fixture. Defaults to a fresh workspace and the `member` role. */
export function makeMembership(
  overrides: Partial<SessionMembership> & { role?: WorkspaceRole } = {},
): SessionMembership {
  return { workspaceId: nextId("ws"), role: "member", ...overrides }
}

export type MakeSessionOptions = Partial<Session> & {
  /** Role in the active workspace. Defaults to `"owner"` (allows everything). */
  role?: WorkspaceRole
  /** Active workspace id. Defaults to a fresh `ws_*` id. */
  workspaceId?: string
  /** `session.user.id`. Defaults to a fresh `user_*` id. */
  userId?: string
  /** `session.user.email`. Defaults to `<userId>@example.com`. */
  email?: string
  /** `session.user.name`. */
  name?: string
}

/**
 * Session fixture using the real `Session` type and real role values from
 * `@yourcrm/auth` — roles are never redeclared here so fixtures cannot drift
 * from production.
 *
 * ```ts
 * const session = makeSession({ role: "viewer" })
 * ```
 */
export function makeSession(options: MakeSessionOptions = {}): Session {
  const { role, userId, email, name, ...rest } = options
  const userIdFinal = userId ?? rest.user?.id ?? nextId("user")
  const userName = name ?? rest.user?.name
  const user: SessionUser = {
    id: userIdFinal,
    email: email ?? rest.user?.email ?? `${userIdFinal}@example.com`,
    ...(userName === undefined ? {} : { name: userName }),
  }
  const activeWorkspace = rest.workspaceId ?? nextId("ws")
  const activeRole = role ?? "owner"
  const memberships = rest.memberships ?? [{ workspaceId: activeWorkspace, role: activeRole }]
  return { user, memberships, workspaceId: activeWorkspace, ...rest }
}
