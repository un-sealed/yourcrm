import { describe, expect, test } from "bun:test"
import {
  buildSessionCookie,
  clearSessionCookie,
  createLoginRateLimiters,
  createMemoryAuthStore,
  GENERIC_LOGIN_FAILURE,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  loginUser,
  logoutUser,
  parseSessionCookie,
  resolveSession,
  roleInWorkspace,
  signupUser,
  tokenHashesEqual,
} from "./index"

async function seededStore() {
  const store = createMemoryAuthStore()
  const passwordHash = await hashPassword("CorrectHorse123!")
  const { userId, workspaceId } = await store.createUserWithWorkspace({
    email: "ada@yourcrm.local",
    name: "Ada",
    passwordHash,
    workspaceName: "Acme",
    workspaceSlug: "acme",
  })
  return { store, userId, workspaceId }
}

describe("auth/service login", () => {
  test("login succeeds and returns the Session contract shape", async () => {
    const { store } = await seededStore()
    const result = await loginUser(
      store,
      { email: "ada@yourcrm.local", password: "CorrectHorse123!" },
      { ip: "10.0.0.1" },
    )
    expect(result.session.user.email).toBe("ada@yourcrm.local")
    expect(result.session.workspaceId).toBe("ws_mem_1")
    expect(result.session.memberships).toHaveLength(1)
    expect(roleInWorkspace(result.session)).toBe("owner")
    expect(result.token.length).toBeGreaterThan(32)
  })

  test("wrong password is rejected with a generic 401", async () => {
    const { store } = await seededStore()
    const err: unknown = await loginUser(
      store,
      { email: "ada@yourcrm.local", password: "wrong-password" },
      { ip: "10.0.0.2" },
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe("INVALID_CREDENTIALS")
    expect((err as { status?: number }).status).toBe(401)
    expect((err as Error).message).toBe(GENERIC_LOGIN_FAILURE)
  })

  test("unknown email yields the identical generic failure", async () => {
    const { store } = await seededStore()
    const wrongPassword: unknown = await loginUser(
      store,
      { email: "ada@yourcrm.local", password: "nope" },
      { ip: "10.0.0.3" },
    ).catch((e: unknown) => (e as Error).message)
    const unknownEmail: unknown = await loginUser(
      store,
      { email: "nobody@yourcrm.local", password: "nope" },
      { ip: "10.0.0.4" },
    ).catch((e: unknown) => (e as Error).message)
    expect(wrongPassword).toBe(unknownEmail)
    expect(unknownEmail).toBe(GENERIC_LOGIN_FAILURE)
  })

  test("email is normalized (case/whitespace) by schema", async () => {
    const { store } = await seededStore()
    const result = await loginUser(
      store,
      { email: "  ADA@yourcrm.local ", password: "CorrectHorse123!" },
      { ip: "10.0.0.5" },
    )
    expect(result.session.user.email).toBe("ada@yourcrm.local")
  })

  test("every login mints a fresh token (fixation-safe)", async () => {
    const { store } = await seededStore()
    const first = await loginUser(
      store,
      { email: "ada@yourcrm.local", password: "CorrectHorse123!" },
      { ip: "10.0.0.6" },
    )
    const second = await loginUser(
      store,
      { email: "ada@yourcrm.local", password: "CorrectHorse123!" },
      { ip: "10.0.0.6" },
    )
    expect(first.token).not.toBe(second.token)
    // Both resolve: rotation issues new tokens, it does not invalidate old ones.
    expect((await resolveSession(store, first.token))?.user.id).toBe(
      (await resolveSession(store, second.token))?.user.id,
    )
  })

  test("login is rate-limited per account", async () => {
    const { store } = await seededStore()
    const limiters = createLoginRateLimiters()
    const now = Date.now()
    for (let i = 0; i < 10; i++) {
      await loginUser(
        store,
        { email: "ada@yourcrm.local", password: "wrong" },
        { ip: "10.0.0.7" },
        limiters,
        now + i,
      ).catch(() => undefined)
    }
    const limited: unknown = await loginUser(
      store,
      { email: "ada@yourcrm.local", password: "wrong" },
      { ip: "10.0.0.7" },
      limiters,
      now + 11,
    ).catch((e: unknown) => e)
    expect((limited as { code?: string }).code).toBe("RATE_LIMITED")
    expect((limited as { status?: number }).status).toBe(429)
  })
})

describe("auth/service resolveSession", () => {
  test("expired sessions are rejected server-side", async () => {
    const store = createMemoryAuthStore()
    const passwordHash = await hashPassword("CorrectHorse123!")
    const { userId, workspaceId } = await store.createUserWithWorkspace({
      email: "ada@yourcrm.local",
      name: "Ada",
      passwordHash,
      workspaceName: "Acme",
      workspaceSlug: "acme",
    })
    const token = generateSessionToken()
    await store.createSession({
      userId,
      workspaceId,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() - 1000),
      userAgent: null,
    })
    expect(await resolveSession(store, token)).toBeNull()
  })

  test("revoked sessions are rejected after logout", async () => {
    const { store } = await seededStore()
    const { token } = await loginUser(
      store,
      { email: "ada@yourcrm.local", password: "CorrectHorse123!" },
      { ip: "10.0.0.8" },
    )
    expect(await resolveSession(store, token)).not.toBeNull()
    await logoutUser(store, token)
    expect(await resolveSession(store, token)).toBeNull()
  })

  test("logout is idempotent for unknown tokens", async () => {
    const { store } = await seededStore()
    await logoutUser(store, generateSessionToken())
    await logoutUser(store, null)
  })

  test("unknown and malformed tokens resolve to null", async () => {
    const { store } = await seededStore()
    expect(await resolveSession(store, generateSessionToken())).toBeNull()
    expect(await resolveSession(store, null)).toBeNull()
    expect(await resolveSession(store, "short")).toBeNull()
  })

  test("token hashes compare in constant time", () => {
    const token = generateSessionToken()
    const hash = hashSessionToken(token)
    expect(tokenHashesEqual(hash, hashSessionToken(token))).toBe(true)
    expect(tokenHashesEqual(hash, hashSessionToken(generateSessionToken()))).toBe(false)
    expect(tokenHashesEqual(hash, "short")).toBe(false)
  })
})

describe("auth/service signup", () => {
  test("signup creates an owner session and duplicate emails are rejected", async () => {
    const store = createMemoryAuthStore()
    const result = await signupUser(store, {
      name: "Grace",
      email: "grace@yourcrm.local",
      password: "Sup3rSecret!!",
    })
    expect(roleInWorkspace(result.session)).toBe("owner")
    expect(result.session.user.email).toBe("grace@yourcrm.local")
    const duplicate: unknown = await signupUser(store, {
      name: "Grace",
      email: "grace@yourcrm.local",
      password: "Sup3rSecret!!",
    }).catch((e: unknown) => e)
    expect((duplicate as { code?: string }).code).toBe("EMAIL_TAKEN")
  })
})

describe("auth/session shape for permissions", () => {
  test("a viewer session carries role=viewer for server-side denial", async () => {
    const session = {
      user: { id: "user_viewer", email: "viewer@yourcrm.local" },
      memberships: [{ workspaceId: "ws_1", role: "viewer" as const }],
      workspaceId: "ws_1",
    }
    // apps/api's authorize() feeds this role into requirePermission(),
    // which denies destructive actions (proven in apps/api middleware tests).
    expect(roleInWorkspace(session)).toBe("viewer")
  })
})

describe("auth/cookies", () => {
  test("session cookie is httpOnly, Secure, SameSite=Lax", () => {
    const header = buildSessionCookie("raw-token")
    expect(header).toContain("HttpOnly")
    expect(header).toContain("Secure")
    expect(header).toContain("SameSite=Lax")
    expect(header).toContain("Path=/")
    expect(parseSessionCookie(`other=1; ${header.split(";")[0]}`)).toBe("raw-token")
  })

  test("logout clears the cookie and parses empty headers safely", () => {
    expect(clearSessionCookie()).toContain("Max-Age=0")
    expect(parseSessionCookie(null)).toBeNull()
    expect(parseSessionCookie("")).toBeNull()
  })
})
