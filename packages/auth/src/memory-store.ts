import type { AuthMembershipRecord, AuthSessionRecord, AuthStore, AuthUserRecord } from "./store"

/**
 * Hermetic in-memory `AuthStore` for unit tests (and downstream agents'
 * tests). No I/O, no clock mocking needed — pass explicit timestamps.
 */
export function createMemoryAuthStore(seed?: {
  users?: AuthUserRecord[]
  memberships?: AuthMembershipRecord[]
  passwordHashes?: Record<string, string>
  sessions?: AuthSessionRecord[]
}): AuthStore {
  const users = new Map<string, AuthUserRecord>()
  const memberships: AuthMembershipRecord[] = []
  const passwordHashes = new Map<string, string>()
  const sessions = new Map<string, AuthSessionRecord>()
  let seq = 0

  for (const u of seed?.users ?? []) users.set(u.id, { ...u })
  memberships.push(...(seed?.memberships ?? []))
  for (const [k, v] of Object.entries(seed?.passwordHashes ?? {})) passwordHashes.set(k, v)
  for (const s of seed?.sessions ?? []) sessions.set(s.tokenHash, { ...s })

  return {
    async findUserByEmail(email) {
      for (const u of users.values()) if (u.email === email) return { ...u }
      return null
    },
    async findUserById(id) {
      const u = users.get(id)
      return u ? { ...u } : null
    },
    async listMembershipsForUser(userId) {
      return memberships.filter((m) => m.userId === userId).map((m) => ({ ...m }))
    },
    async findWorkspaceBySlug() {
      return null
    },
    async getPasswordHash(userId) {
      return passwordHashes.get(userId) ?? null
    },
    async createUserWithWorkspace(input) {
      seq += 1
      const userId = `user_mem_${seq}`
      const workspaceId = `ws_mem_${seq}`
      users.set(userId, { id: userId, email: input.email, name: input.name })
      memberships.push({ userId, workspaceId, role: "owner" })
      passwordHashes.set(userId, input.passwordHash)
      return { userId, workspaceId }
    },
    async createSession(input) {
      seq += 1
      const row: AuthSessionRecord = {
        id: `sess_mem_${seq}`,
        lastUsedAt: new Date(),
        revokedAt: null,
        ...input,
      }
      sessions.set(row.tokenHash, row)
      return { ...row }
    },
    async findSessionByTokenHash(tokenHash) {
      const row = sessions.get(tokenHash)
      return row ? { ...row } : null
    },
    async touchSession(id) {
      for (const row of sessions.values()) {
        if (row.id === id) {
          row.lastUsedAt = new Date()
          return
        }
      }
    },
    async touchLastLogin() {},
    async revokeSessionByTokenHash(tokenHash) {
      const row = sessions.get(tokenHash)
      if (row) row.revokedAt = new Date()
    },
  }
}
