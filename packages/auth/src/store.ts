import type { Session } from "./session"

/**
 * Persistence port for the auth service. Structurally satisfied by the
 * drizzle implementation in `@yourcrm/database` (`schema/auth.ts`) via an
 * adapter in `apps/api`, and by `createMemoryAuthStore()` for hermetic
 * tests. `@yourcrm/auth` never imports `@yourcrm/database` (base packages
 * must not depend on infra) — this interface is the seam.
 */

export type AuthUserRecord = {
  id: string
  email: string
  name: string | null
}

export type AuthMembershipRecord = {
  workspaceId: string
  userId: string
  role: string
}

export type AuthSessionRecord = {
  id: string
  userId: string
  workspaceId: string
  tokenHash: string
  expiresAt: Date
  lastUsedAt: Date
  userAgent: string | null
  revokedAt: Date | null
}

export type AuthStore = {
  findUserByEmail(email: string): Promise<AuthUserRecord | null>
  findUserById(id: string): Promise<AuthUserRecord | null>
  listMembershipsForUser(userId: string): Promise<AuthMembershipRecord[]>
  findWorkspaceBySlug(slug: string): Promise<{ id: string } | null>
  getPasswordHash(userId: string): Promise<string | null>
  /** Atomic: user + workspace + owner membership + credential. */
  createUserWithWorkspace(input: {
    email: string
    name: string
    passwordHash: string
    workspaceName: string
    workspaceSlug: string
  }): Promise<{ userId: string; workspaceId: string }>
  createSession(input: {
    userId: string
    workspaceId: string
    tokenHash: string
    expiresAt: Date
    userAgent: string | null
  }): Promise<AuthSessionRecord>
  findSessionByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null>
  touchSession(id: string): Promise<void>
  touchLastLogin(userId: string): Promise<void>
  revokeSessionByTokenHash(tokenHash: string): Promise<void>
}

export type { Session }
