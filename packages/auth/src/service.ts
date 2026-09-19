import { AuthError } from "./errors"
import { hashPassword, verifyPassword } from "./password"
import { createLoginRateLimiters, type LoginRateLimiters } from "./rate-limit"
import { loginSchema, signupSchema, type LoginInput, type SignupInput } from "./schemas"
import { devSession, type Session, type WorkspaceRole } from "./session"
import type { AuthStore } from "./store"
import { generateSessionToken, hashSessionToken, tokenHashesEqual } from "./tokens"

/**
 * Email+password auth service (Wave-1, spec 04). Framework-free: Hono
 * handlers and Next.js code call these functions with an `AuthStore`; all
 * SQL lives in `@yourcrm/database`. The `Session` shape returned here is
 * the unchanged contract `requirePermission()` consumes.
 */

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Generic login failure — never reveals whether the email exists. */
export const GENERIC_LOGIN_FAILURE = "Invalid email or password"

export type RequestMeta = {
  ip?: string
  userAgent?: string | null
}

export type AuthResult = {
  session: Session
  /** Raw token: set it as the session cookie, never store or log it. */
  token: string
  expiresAt: Date
}

export function slugifyWorkspace(name: string): string {
  const base =
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "workspace"
  return base
}

function toSessionMemberships(rows: { workspaceId: string; role: string }[]) {
  return rows.map((m) => ({
    workspaceId: m.workspaceId,
    role: (m.role === "owner" || m.role === "admin" || m.role === "member"
      ? m.role
      : "viewer") as WorkspaceRole,
  }))
}

function buildSession(
  user: { id: string; email: string; name: string | null },
  membershipRows: { workspaceId: string; role: string }[],
  workspaceId: string,
  expiresAt: Date,
): Session {
  return {
    user: { id: user.id, email: user.email, ...(user.name ? { name: user.name } : {}) },
    memberships: toSessionMemberships(membershipRows),
    workspaceId,
    expiresAt: expiresAt.toISOString(),
  }
}

async function uniqueWorkspaceSlug(store: AuthStore, base: string): Promise<string> {
  let slug = base
  for (let attempt = 0; attempt < 100; attempt++) {
    const existing = await store.findWorkspaceBySlug(attempt === 0 ? slug : `${base}-${attempt}`)
    if (!existing) return attempt === 0 ? slug : `${base}-${attempt}`
    slug = `${base}-${attempt}`
  }
  throw new AuthError("NO_WORKSPACE", "Could not allocate a workspace slug", 500)
}

async function issueSession(
  store: AuthStore,
  user: { id: string; email: string; name: string | null },
  membershipRows: { workspaceId: string; role: string }[],
  meta: RequestMeta,
  now: number,
): Promise<AuthResult> {
  // Prefer an owned/admin workspace, else the first membership.
  const active =
    membershipRows.find((m) => m.role === "owner") ??
    membershipRows.find((m) => m.role === "admin") ??
    membershipRows[0]
  if (!active) throw new AuthError("NO_WORKSPACE", "Account has no workspace", 403)
  // A fresh CSPRNG token on every login: fixation-safe by construction.
  const token = generateSessionToken()
  const tokenHash = hashSessionToken(token)
  const expiresAt = new Date(now + SESSION_TTL_MS)
  await store.createSession({
    userId: user.id,
    workspaceId: active.workspaceId,
    tokenHash,
    expiresAt,
    userAgent: meta.userAgent ?? null,
  })
  await store.touchLastLogin(user.id).catch(() => undefined)
  return {
    session: buildSession(user, membershipRows, active.workspaceId, expiresAt),
    token,
    expiresAt,
  }
}

/** Signup: user + workspace + owner membership in one store transaction. */
export async function signupUser(
  store: AuthStore,
  raw: SignupInput,
  meta: RequestMeta = {},
  now = Date.now(),
): Promise<AuthResult> {
  const input = signupSchema.parse(raw)
  const existing = await store.findUserByEmail(input.email)
  if (existing) throw new AuthError("EMAIL_TAKEN", "An account with this email already exists", 409)
  const workspaceName = input.workspaceName ?? `${input.name}'s workspace`
  const slug = await uniqueWorkspaceSlug(store, slugifyWorkspace(workspaceName))
  const passwordHash = await hashPassword(input.password)
  const { userId, workspaceId } = await store.createUserWithWorkspace({
    email: input.email,
    name: input.name,
    passwordHash,
    workspaceName,
    workspaceSlug: slug,
  })
  const user = (await store.findUserById(userId)) ?? {
    id: userId,
    email: input.email,
    name: input.name,
  }
  const memberships = await store.listMembershipsForUser(userId)
  const token = generateSessionToken()
  const expiresAt = new Date(now + SESSION_TTL_MS)
  await store.createSession({
    userId,
    workspaceId,
    tokenHash: hashSessionToken(token),
    expiresAt,
    userAgent: meta.userAgent ?? null,
  })
  return { session: buildSession(user, memberships, workspaceId, expiresAt), token, expiresAt }
}

/**
 * Login. Failures are generic (`INVALID_CREDENTIALS`, 401) whether the
 * email is unknown or the password is wrong; rate limits apply per IP and
 * per account before any credential check.
 */
export async function loginUser(
  store: AuthStore,
  raw: LoginInput,
  meta: RequestMeta = {},
  limiters: LoginRateLimiters = createLoginRateLimiters(),
  now = Date.now(),
): Promise<AuthResult> {
  const input = loginSchema.parse(raw)
  const ipKey = `ip:${meta.ip ?? "unknown"}`
  const accountKey = `account:${input.email}`
  if (!limiters.perIp.isAllowed(ipKey, now) || !limiters.perAccount.isAllowed(accountKey, now)) {
    throw new AuthError("RATE_LIMITED", "Too many login attempts. Try again later.", 429)
  }
  const fail = () => new AuthError("INVALID_CREDENTIALS", GENERIC_LOGIN_FAILURE, 401)
  const user = await store.findUserByEmail(input.email)
  const storedHash = user ? await store.getPasswordHash(user.id) : null
  const ok = storedHash ? await verifyPassword(input.password, storedHash) : false
  if (!user || !storedHash || !ok) throw fail()
  limiters.perAccount.reset(accountKey)
  const memberships = await store.listMembershipsForUser(user.id)
  return issueSession(store, user, memberships, meta, now)
}

/** Logout: server-side revocation. Idempotent — unknown tokens are a no-op. */
export async function logoutUser(
  store: AuthStore,
  rawToken: string | null | undefined,
): Promise<void> {
  if (!rawToken) return
  await store.revokeSessionByTokenHash(hashSessionToken(rawToken))
}

/**
 * Resolve a raw session token to the `Session` contract. Returns null for
 * unknown, expired, or revoked sessions; expiry is enforced here, never by
 * the cookie. Refreshes `last_used_at` (best-effort).
 */
export async function resolveSession(
  store: AuthStore,
  rawToken: string | null | undefined,
  now = Date.now(),
): Promise<Session | null> {
  if (!rawToken || rawToken.length < 16) return null
  const tokenHash = hashSessionToken(rawToken)
  const row = await store.findSessionByTokenHash(tokenHash)
  if (!row) return null
  if (!tokenHashesEqual(row.tokenHash, tokenHash)) return null
  if (row.revokedAt) return null
  if (row.expiresAt.getTime() <= now) return null
  const user = await store.findUserById(row.userId)
  if (!user) return null
  const memberships = await store.listMembershipsForUser(user.id)
  if (!memberships.some((m) => m.workspaceId === row.workspaceId)) return null
  await store.touchSession(row.id).catch(() => undefined)
  return buildSession(user, memberships, row.workspaceId, row.expiresAt)
}

export { devSession }
