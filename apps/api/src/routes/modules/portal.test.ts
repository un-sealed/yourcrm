import { beforeEach, describe, expect, test } from "bun:test"
import {
  createLoginRateLimiters,
  createMemoryAuthStore,
  hashSessionToken,
  SESSION_COOKIE_NAME,
} from "@yourcrm/auth"
import {
  createPortalService,
  type PortalBillingReader,
  type PortalGrantRecord,
  type PortalIdentityRecord,
  type PortalIdentityStore,
  type PortalMagicLinkMessage,
  type PortalService,
  type PortalSessionRecord,
  type PortalSessionStore,
  type PortalSourceRecord,
  type PortalTicketReader,
} from "@yourcrm/crm/src/portal"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { auth } from "../../middleware/auth"
import { createRoutes as createPeopleRoutes } from "./people"
import { createRoutes, PORTAL_SESSION_COOKIE_NAME } from "./portal"

/**
 * Customer portal API tests.
 *
 * Two properties get the most attention here, because they are the ones an
 * HTTP layer can break on its own even when the domain service is correct:
 *
 *  1. STATUS CODES CARRY NO INFORMATION. Somebody else's invoice is 404, the
 *     same as an invoice that never existed. There is no 403 anywhere in the
 *     portal, and a test sweeps every route to prove it.
 *  2. THE TWO TOKEN SPACES DO NOT MEET. A portal token is fed to the member
 *     auth middleware, and a member cookie is fed to the portal — both are
 *     rejected. That test mounts the REAL `auth()` middleware over the real
 *     `/people` router, so it is not testing a mock of the thing it claims.
 */

const WS = "ws-1"
const PERSON_A = "person-a"
const PERSON_B = "person-b"
const IDENTITY_A = "identity-a"
const IDENTITY_B = "identity-b"

type Row = PortalSourceRecord & { workspaceId: string; personId: string | null }

const invoiceRows: Row[] = [
  {
    id: "inv-a",
    workspaceId: WS,
    personId: PERSON_A,
    number: "INV-A",
    status: "sent",
    currency: "USD",
    dueDate: "2026-06-30",
    totalCents: 10_000,
    paidCents: 0,
    notes: "internal collection note",
    ownerId: "member-1",
  },
  {
    id: "inv-b",
    workspaceId: WS,
    personId: PERSON_B,
    number: "INV-B",
    status: "sent",
    currency: "USD",
    dueDate: "2026-06-30",
    totalCents: 20_000,
    paidCents: 0,
    notes: "other customer",
    ownerId: "member-2",
  },
]

const ticketRows: Row[] = [
  { id: "ticket-a", workspaceId: WS, personId: PERSON_A, subject: "Mine", status: "open" },
  { id: "ticket-b", workspaceId: WS, personId: PERSON_B, subject: "Theirs", status: "open" },
]

function scoped(rows: Row[], personIds: readonly string[], workspaceId: string): Row[] {
  return rows.filter(
    (row) =>
      row.workspaceId === workspaceId && row.personId !== null && personIds.includes(row.personId),
  )
}

function makeService(): {
  service: PortalService
  delivered: PortalMagicLinkMessage[]
  auditActions: string[]
} {
  const delivered: PortalMagicLinkMessage[] = []
  const auditActions: string[] = []
  const rows: (PortalSessionRecord & {
    kind: string
    tokenHash: string
    consumedAt: Date | null
    revokedAt: Date | null
  })[] = []
  let seq = 0

  const identities: PortalIdentityRecord[] = [
    {
      id: IDENTITY_A,
      workspaceId: WS,
      personId: PERSON_A,
      email: "a@example.com",
      displayName: "A",
    },
    {
      id: IDENTITY_B,
      workspaceId: WS,
      personId: PERSON_B,
      email: "b@example.com",
      displayName: "B",
    },
  ]
  const grants: Record<string, PortalGrantRecord[]> = {
    [IDENTITY_A]: [
      {
        scopeType: "person",
        scopeId: PERSON_A,
        canViewTickets: true,
        canViewInvoices: true,
        canViewQuotes: true,
      },
    ],
    [IDENTITY_B]: [
      {
        scopeType: "person",
        scopeId: PERSON_B,
        canViewTickets: true,
        canViewInvoices: true,
        canViewQuotes: true,
      },
    ],
  }

  const identityStore: PortalIdentityStore = {
    findActiveByEmail: async (email) => identities.filter((row) => row.email === email),
    findActiveById: async (workspaceId, id) =>
      identities.find((row) => row.id === id && row.workspaceId === workspaceId) ?? null,
    listActiveGrants: async (_workspaceId, identityId) => grants[identityId] ?? [],
    markLogin: async () => undefined,
  }

  const sessionStore: PortalSessionStore = {
    createMagicLink: async (input) => {
      const row = {
        id: `magic-${(seq += 1)}`,
        kind: "magic_link",
        consumedAt: null,
        revokedAt: null,
        ...input,
      }
      rows.push(row)
      return row
    },
    consumeMagicLink: async (tokenHash) => {
      const row = rows.find(
        (candidate) =>
          candidate.kind === "magic_link" &&
          candidate.tokenHash === tokenHash &&
          candidate.consumedAt === null,
      )
      if (!row) return null
      row.consumedAt = new Date()
      return row
    },
    createSession: async (input) => {
      const row = {
        id: `session-${(seq += 1)}`,
        kind: "session",
        consumedAt: null,
        revokedAt: null,
        ...input,
      }
      rows.push(row)
      return row
    },
    findActiveSession: async (tokenHash) =>
      rows.find(
        (row) =>
          row.kind === "session" &&
          row.tokenHash === tokenHash &&
          row.revokedAt === null &&
          row.expiresAt.getTime() > Date.now(),
      ) ?? null,
    touchSession: async () => undefined,
    revokeSession: async (_workspaceId, sessionId) => {
      const row = rows.find((candidate) => candidate.id === sessionId)
      if (row) row.revokedAt = new Date()
    },
  }

  const billing: PortalBillingReader = {
    listInvoices: async (scope, query) => ({
      data: scoped(invoiceRows, scope.personIds, scope.workspaceId),
      pagination: { nextCursor: null, limit: query.limit ?? 25 },
    }),
    findInvoice: async (scope, invoiceId) => {
      const invoice = scoped(invoiceRows, scope.personIds, scope.workspaceId).find(
        (row) => row.id === invoiceId,
      )
      return invoice ? { invoice, lineItems: [], amountPaidCents: 0 } : null
    },
    listQuotes: async (_scope, query) => ({
      data: [],
      pagination: { nextCursor: null, limit: query.limit ?? 25 },
    }),
    findQuote: async () => null,
  }

  const tickets: PortalTicketReader = {
    list: async (scope, query) => ({
      data: scoped(ticketRows, scope.personIds, scope.workspaceId),
      pagination: { nextCursor: null, limit: query.limit ?? 25 },
    }),
    findById: async (scope, ticketId) => {
      const ticket = scoped(ticketRows, scope.personIds, scope.workspaceId).find(
        (row) => row.id === ticketId,
      )
      if (!ticket) return null
      return {
        ticket,
        comments: [
          { id: "public-1", body: "Shipping today.", visibility: "public" },
          { id: "internal-1", body: "Do not offer a refund.", visibility: "internal" },
        ],
      }
    },
  }

  const service = createPortalService({
    identities: identityStore,
    sessions: sessionStore,
    tokens: {
      generate: () => `portal-token-${(seq += 1)}-0123456789abcdef`,
      hash: (token) => `sha256(${token})`,
    },
    billing,
    tickets,
    deliverMagicLink: async (message) => {
      delivered.push(message)
    },
    audit: async (input) => {
      auditActions.push(input.action)
    },
  })

  return { service, delivered, auditActions }
}

function makeApp(service: PortalService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("requestId", "req-portal")
    // The portal never reads this, but the real app always sets it — so the
    // test app does too, and a handler that reached for it would still be
    // reaching for a member session that does not exist.
    c.set("session", null)
    await next()
  })
  app.route(
    "/api/v1/portal",
    createRoutes({ service, secureCookies: false, limiters: createLoginRateLimiters() }),
  )
  return app
}

function cookieFrom(res: Response): string {
  const header = res.headers.get("set-cookie") ?? ""
  return header.split(";")[0] ?? ""
}

async function login(app: Hono<AppEnv>, delivered: PortalMagicLinkMessage[], email: string) {
  await app.request("/api/v1/portal/auth/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  })
  const token = delivered[delivered.length - 1]?.token ?? ""
  const res = await app.request("/api/v1/portal/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  })
  return { res, cookie: cookieFrom(res) }
}

describe("api/portal: magic-link login", () => {
  let harness: ReturnType<typeof makeService>
  let app: Hono<AppEnv>

  beforeEach(() => {
    harness = makeService()
    app = makeApp(harness.service)
  })

  test("known and unknown addresses are indistinguishable", async () => {
    const known = await app.request("/api/v1/portal/auth/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.com" }),
    })
    const unknown = await app.request("/api/v1/portal/auth/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com" }),
    })
    expect(known.status).toBe(202)
    expect(unknown.status).toBe(202)
    expect(await known.json()).toEqual(await unknown.json())
    expect(harness.delivered).toHaveLength(1)
  })

  test("a malformed email is a 400, not a hint", async () => {
    const res = await app.request("/api/v1/portal/auth/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR")
  })

  test("requests are rate limited without revealing whether the address exists", async () => {
    let last = new Response()
    for (let i = 0; i < 12; i += 1) {
      last = await app.request("/api/v1/portal/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.5" },
        body: JSON.stringify({ email: "ghost@example.com" }),
      })
    }
    expect(last.status).toBe(429)
    expect(((await last.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED")
  })

  test("exchanging a link sets an httpOnly portal cookie with its own name", async () => {
    const { res } = await login(app, harness.delivered, "a@example.com")
    expect(res.status).toBe(200)
    const setCookie = res.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain(`${PORTAL_SESSION_COOKIE_NAME}=`)
    expect(setCookie).not.toContain(`${SESSION_COOKIE_NAME}=`)
    expect(setCookie.toLowerCase()).toContain("httponly")
    expect(setCookie.toLowerCase()).toContain("samesite=lax")
  })

  test("a magic link cannot be replayed", async () => {
    await app.request("/api/v1/portal/auth/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.com" }),
    })
    const token = harness.delivered[0]?.token ?? ""
    const first = await app.request("/api/v1/portal/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
    const second = await app.request("/api/v1/portal/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(401)
  })

  test("logout revokes the session and clears the cookie", async () => {
    const { cookie } = await login(app, harness.delivered, "a@example.com")
    const out = await app.request("/api/v1/portal/auth/logout", {
      method: "POST",
      headers: { cookie },
    })
    expect(out.status).toBe(200)
    const after = await app.request("/api/v1/portal/me", { headers: { cookie } })
    expect(after.status).toBe(401)
  })
})

describe("api/portal: scope containment over HTTP", () => {
  let harness: ReturnType<typeof makeService>
  let app: Hono<AppEnv>
  let cookieA = ""
  let cookieB = ""

  beforeEach(async () => {
    harness = makeService()
    app = makeApp(harness.service)
    cookieA = (await login(app, harness.delivered, "a@example.com")).cookie
    cookieB = (await login(app, harness.delivered, "b@example.com")).cookie
  })

  test("each identity lists only its own invoices", async () => {
    const a = await app.request("/api/v1/portal/invoices", { headers: { cookie: cookieA } })
    const b = await app.request("/api/v1/portal/invoices", { headers: { cookie: cookieB } })
    const dataA = (await a.json()) as { data: { id: string }[] }
    const dataB = (await b.json()) as { data: { id: string }[] }
    expect(dataA.data.map((row) => row.id)).toEqual(["inv-a"])
    expect(dataB.data.map((row) => row.id)).toEqual(["inv-b"])
  })

  test("reading another identity's invoice is 404 — never 403", async () => {
    const res = await app.request("/api/v1/portal/invoices/inv-b", { headers: { cookie: cookieA } })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND")
  })

  test("a foreign record and a nonexistent record answer identically", async () => {
    const foreign = await app.request("/api/v1/portal/invoices/inv-b", {
      headers: { cookie: cookieA },
    })
    const missing = await app.request("/api/v1/portal/invoices/inv-nope", {
      headers: { cookie: cookieA },
    })
    expect(foreign.status).toBe(missing.status)
    expect(await foreign.json()).toEqual(await missing.json())
  })

  test("the same holds for tickets, by id and through the list", async () => {
    const list = await app.request("/api/v1/portal/tickets", { headers: { cookie: cookieA } })
    expect(((await list.json()) as { data: { id: string }[] }).data.map((row) => row.id)).toEqual([
      "ticket-a",
    ])
    const foreign = await app.request("/api/v1/portal/tickets/ticket-b", {
      headers: { cookie: cookieA },
    })
    expect(foreign.status).toBe(404)
  })

  test("query parameters naming another identity change nothing", async () => {
    const res = await app.request(
      `/api/v1/portal/invoices?personId=${PERSON_B}&companyId=any&ownerId=member-2&workspaceId=ws-other`,
      { headers: { cookie: cookieA } },
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { id: string }[] }).data.map((row) => row.id)).toEqual([
      "inv-a",
    ])
  })

  test("an out-of-enum status filter is a 400, not a wider query", async () => {
    const res = await app.request("/api/v1/portal/invoices?status=draft", {
      headers: { cookie: cookieA },
    })
    expect(res.status).toBe(400)
  })

  test("internal fields never reach the wire", async () => {
    const res = await app.request("/api/v1/portal/invoices/inv-a", { headers: { cookie: cookieA } })
    const body = await res.text()
    expect(body).not.toContain("internal collection note")
    expect(body).not.toContain("member-1")
    expect(body).not.toContain(PERSON_A)

    const ticket = await app.request("/api/v1/portal/tickets/ticket-a", {
      headers: { cookie: cookieA },
    })
    const ticketBody = await ticket.text()
    expect(ticketBody).toContain("Shipping today.")
    expect(ticketBody).not.toContain("Do not offer a refund.")
  })

  test("every portal read is audited", async () => {
    harness.auditActions.length = 0
    await app.request("/api/v1/portal/invoices", { headers: { cookie: cookieA } })
    await app.request("/api/v1/portal/invoices/inv-a", { headers: { cookie: cookieA } })
    await app.request("/api/v1/portal/invoices/inv-b", { headers: { cookie: cookieA } })
    expect(harness.auditActions).toEqual(["portal.list", "portal.read", "portal.denied"])
  })
})

describe("api/portal: the portal is not a member surface", () => {
  const routes = [
    "/api/v1/portal/me",
    "/api/v1/portal/tickets",
    "/api/v1/portal/tickets/ticket-a",
    "/api/v1/portal/invoices",
    "/api/v1/portal/invoices/inv-a",
    "/api/v1/portal/quotes",
    "/api/v1/portal/quotes/quote-a",
  ]

  test("every read route is 401 without a portal session, and never 403", async () => {
    const harness = makeService()
    const app = makeApp(harness.service)
    for (const route of routes) {
      const res = await app.request(route)
      expect(res.status, `${route} unauthenticated`).toBe(401)
    }
  })

  test("no portal response is ever a 403", async () => {
    const harness = makeService()
    const app = makeApp(harness.service)
    const { cookie } = await login(app, harness.delivered, "a@example.com")
    const statuses: number[] = []
    for (const route of [...routes, "/api/v1/portal/invoices/inv-b"]) {
      statuses.push((await app.request(route, { headers: { cookie } })).status)
      statuses.push((await app.request(route)).status)
    }
    expect(statuses).not.toContain(403)
  })

  test("a member session cookie does not open the portal", async () => {
    const harness = makeService()
    const app = makeApp(harness.service)
    const res = await app.request("/api/v1/portal/me", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=a-member-session-token` },
    })
    expect(res.status).toBe(401)
  })

  test("a portal token does not authenticate against the member API", async () => {
    const harness = makeService()
    const portalApp = makeApp(harness.service)
    const { cookie } = await login(portalApp, harness.delivered, "a@example.com")
    const portalToken = cookie.split("=")[1] ?? ""
    expect(portalToken).not.toBe("")

    // Real member auth middleware over a real member router, backed by an
    // auth store that knows nothing about portal tokens.
    const memberApp = new Hono<AppEnv>()
    memberApp.use("*", async (c, next) => {
      c.set("requestId", "req-member")
      await next()
    })
    memberApp.use("*", auth(createMemoryAuthStore()))
    memberApp.route("/api/v1/people", createPeopleRoutes({}))

    const asBearer = await memberApp.request("/api/v1/people", {
      headers: { authorization: `Bearer ${portalToken}` },
    })
    const asCookie = await memberApp.request("/api/v1/people", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${portalToken}` },
    })
    expect(asBearer.status).toBe(401)
    expect(asCookie.status).toBe(401)
    // And the portal token's hash is not a member session token hash either.
    expect(hashSessionToken(portalToken)).not.toBe(portalToken)
  })
})
