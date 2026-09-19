import { beforeEach, describe, expect, test } from "bun:test"
import {
  createPortalService,
  portalScopeFor,
  PortalNotFoundError,
  PortalUnauthorizedError,
  type PortalService,
} from "./service"
import type {
  PortalAuditInput,
  PortalBillingReader,
  PortalContext,
  PortalGrantRecord,
  PortalIdentityRecord,
  PortalIdentityStore,
  PortalMagicLinkMessage,
  PortalPage,
  PortalScope,
  PortalSessionRecord,
  PortalSessionStore,
  PortalSourceRecord,
  PortalTicketReader,
} from "./types"

/**
 * Customer portal service tests.
 *
 * THE CENTRAL FIXTURE IS TWO CUSTOMERS, NOT ONE. Identity A and identity B
 * belong to the same workspace and have identically shaped data, so every
 * "A cannot see B" assertion below is about the scope and nothing else —
 * not about a missing row, a different tenant or a typo'd id.
 *
 * The fake billing reader and ticket reader apply the scope the same way the
 * SQL does (filter by workspace, then by person/company membership of the
 * scope, then by portal-visible status). That is deliberate: it makes these
 * tests a check on the SERVICE's scope derivation. The companion check —
 * that the real repository actually puts that scope in the WHERE clause —
 * lives in `packages/database/src/repositories/portal-repository.test.ts`.
 */

const WS = "ws-1"
const PERSON_A = "person-a"
const PERSON_B = "person-b"
const COMPANY_A = "company-a"
const IDENTITY_A = "identity-a"
const IDENTITY_B = "identity-b"

const NOW = new Date("2026-06-01T10:00:00.000Z")

type FakeInvoice = PortalSourceRecord & {
  workspaceId: string
  personId: string | null
  companyId: string | null
  status: string
  // Internal fields that must never reach a portal response.
  notes: string
  ownerId: string
}

type FakeTicket = PortalSourceRecord & {
  workspaceId: string
  personId: string | null
  companyId: string | null
  status: string
  assigneeId: string
  internalRating: number
}

const invoiceRows: FakeInvoice[] = [
  {
    id: "inv-a",
    workspaceId: WS,
    personId: PERSON_A,
    companyId: null,
    number: "INV-A",
    status: "sent",
    currency: "USD",
    dueDate: "2026-06-30",
    totalCents: 10_000,
    paidCents: 2_500,
    notes: "customer is late paying, chase via owner",
    ownerId: "member-1",
  },
  {
    id: "inv-b",
    workspaceId: WS,
    personId: PERSON_B,
    companyId: null,
    number: "INV-B",
    status: "sent",
    currency: "USD",
    dueDate: "2026-06-30",
    totalCents: 50_000,
    paidCents: 0,
    notes: "do not discount",
    ownerId: "member-2",
  },
  {
    id: "inv-company",
    workspaceId: WS,
    personId: null,
    companyId: COMPANY_A,
    number: "INV-C",
    status: "paid",
    currency: "USD",
    dueDate: null,
    totalCents: 1_000,
    paidCents: 1_000,
    notes: "",
    ownerId: "member-1",
  },
  {
    id: "inv-draft",
    workspaceId: WS,
    personId: PERSON_A,
    companyId: null,
    number: "INV-DRAFT",
    status: "draft",
    currency: "USD",
    dueDate: null,
    totalCents: 9_999,
    paidCents: 0,
    notes: "not sent yet",
    ownerId: "member-1",
  },
]

const ticketRows: FakeTicket[] = [
  {
    id: "ticket-a",
    workspaceId: WS,
    personId: PERSON_A,
    companyId: null,
    subject: "Printer on fire",
    status: "open",
    priority: "high",
    assigneeId: "member-1",
    internalRating: 3,
  },
  {
    id: "ticket-b",
    workspaceId: WS,
    personId: PERSON_B,
    companyId: null,
    subject: "Cannot log in",
    status: "open",
    priority: "low",
    assigneeId: "member-2",
    internalRating: 1,
  },
]

const ticketComments: Record<string, PortalSourceRecord[]> = {
  "ticket-a": [
    {
      id: "comment-public",
      body: "We are sending a replacement today.",
      visibility: "public",
      authorType: "agent",
      authorName: "Sam",
      createdAt: "2026-05-30T09:00:00.000Z",
    },
    {
      id: "comment-internal",
      body: "Customer is on the churn-risk list, do not offer credit.",
      visibility: "internal",
      authorType: "agent",
      authorName: "Sam",
      createdAt: "2026-05-30T09:05:00.000Z",
    },
    {
      // No visibility field at all: must be treated as internal.
      id: "comment-unknown",
      body: "Escalated to engineering, see JIRA-123.",
      authorType: "agent",
      createdAt: "2026-05-30T09:10:00.000Z",
    },
  ],
  "ticket-b": [{ id: "comment-b", body: "Reset sent.", visibility: "public", authorType: "agent" }],
}

/** Mirrors the SQL predicate: workspace + (person IN scope OR company IN scope). */
function inScope(
  row: { workspaceId: string; personId: string | null; companyId: string | null },
  scope: PortalScope,
): boolean {
  if (row.workspaceId !== scope.workspaceId) return false
  const byPerson = row.personId !== null && scope.personIds.includes(row.personId)
  const byCompany = row.companyId !== null && scope.companyIds.includes(row.companyId)
  return byPerson || byCompany
}

function page<T>(data: T[], limit = 25): PortalPage<T> {
  return { data, pagination: { nextCursor: null, limit } }
}

function makeBilling(): PortalBillingReader {
  const visible = (row: FakeInvoice) => row.status === "sent" || row.status === "paid"
  return {
    listInvoices: async (scope, query) =>
      page(
        invoiceRows.filter(
          (row) =>
            inScope(row, scope) && visible(row) && (!query.status || row.status === query.status),
        ),
        query.limit ?? 25,
      ),
    findInvoice: async (scope, invoiceId) => {
      const invoice = invoiceRows.find(
        (row) => row.id === invoiceId && inScope(row, scope) && visible(row),
      )
      if (!invoice) return null
      return {
        invoice,
        lineItems: [{ id: "li-1", description: "Consulting", quantity: 2, unitAmountCents: 5_000 }],
        amountPaidCents: 2_500,
      }
    },
    listQuotes: async (_scope, query) => page([], query.limit ?? 25),
    findQuote: async () => null,
  }
}

function makeTickets(): PortalTicketReader {
  return {
    list: async (scope, query) =>
      page(
        ticketRows.filter(
          (row) => inScope(row, scope) && (!query.status || row.status === query.status),
        ),
        query.limit ?? 25,
      ),
    findById: async (scope, ticketId) => {
      const ticket = ticketRows.find((row) => row.id === ticketId && inScope(row, scope))
      if (!ticket) return null
      return { ticket, comments: ticketComments[ticket.id] ?? [] }
    },
  }
}

type Harness = {
  service: PortalService
  audits: PortalAuditInput[]
  delivered: PortalMagicLinkMessage[]
  sessionRows: (PortalSessionRecord & {
    kind: string
    tokenHash: string
    consumedAt: Date | null
    revokedAt: Date | null
  })[]
  identities: PortalIdentityRecord[]
  grants: Record<string, PortalGrantRecord[]>
  revokeIdentity: (identityId: string) => void
  tokens: string[]
}

function grant(overrides: Partial<PortalGrantRecord> = {}): PortalGrantRecord {
  return {
    scopeType: "person",
    scopeId: PERSON_A,
    canViewTickets: true,
    canViewInvoices: true,
    canViewQuotes: true,
    ...overrides,
  }
}

function makeHarness(options: { tickets?: boolean } = {}): Harness {
  const audits: PortalAuditInput[] = []
  const delivered: PortalMagicLinkMessage[] = []
  const tokens: string[] = []
  const sessionRows: Harness["sessionRows"] = []
  const revoked = new Set<string>()

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
    [IDENTITY_A]: [grant(), grant({ scopeType: "company", scopeId: COMPANY_A })],
    [IDENTITY_B]: [grant({ scopeId: PERSON_B })],
  }

  let counter = 0
  const identityStore: PortalIdentityStore = {
    findActiveByEmail: async (email) =>
      identities.filter((identity) => identity.email === email && !revoked.has(identity.id)),
    findActiveById: async (workspaceId, id) =>
      identities.find(
        (identity) =>
          identity.id === id && identity.workspaceId === workspaceId && !revoked.has(identity.id),
      ) ?? null,
    listActiveGrants: async (_workspaceId, identityId) => grants[identityId] ?? [],
    markLogin: async () => undefined,
  }

  const sessionStore: PortalSessionStore = {
    createMagicLink: async (input) => {
      const row = {
        id: `magic-${(counter += 1)}`,
        workspaceId: input.workspaceId,
        portalIdentityId: input.portalIdentityId,
        expiresAt: input.expiresAt,
        kind: "magic_link",
        tokenHash: input.tokenHash,
        consumedAt: null,
        revokedAt: null,
      }
      sessionRows.push(row)
      return row
    },
    // Mirrors the atomic guarded UPDATE: unused, unrevoked, unexpired.
    consumeMagicLink: async (tokenHash) => {
      const row = sessionRows.find(
        (candidate) =>
          candidate.kind === "magic_link" &&
          candidate.tokenHash === tokenHash &&
          candidate.consumedAt === null &&
          candidate.revokedAt === null &&
          candidate.expiresAt.getTime() > NOW.getTime(),
      )
      if (!row) return null
      row.consumedAt = NOW
      return row
    },
    createSession: async (input) => {
      const row = {
        id: `session-${(counter += 1)}`,
        workspaceId: input.workspaceId,
        portalIdentityId: input.portalIdentityId,
        expiresAt: input.expiresAt,
        kind: "session",
        tokenHash: input.tokenHash,
        consumedAt: null,
        revokedAt: null,
      }
      sessionRows.push(row)
      return row
    },
    findActiveSession: async (tokenHash) =>
      sessionRows.find(
        (row) =>
          row.kind === "session" &&
          row.tokenHash === tokenHash &&
          row.revokedAt === null &&
          row.expiresAt.getTime() > NOW.getTime(),
      ) ?? null,
    touchSession: async () => undefined,
    revokeSession: async (workspaceId, sessionId) => {
      const row = sessionRows.find(
        (candidate) => candidate.id === sessionId && candidate.workspaceId === workspaceId,
      )
      if (row) row.revokedAt = NOW
    },
  }

  const service = createPortalService({
    identities: identityStore,
    sessions: sessionStore,
    tokens: {
      generate: () => {
        const token = `raw-portal-token-${tokens.length + 1}-0123456789abcdef`
        tokens.push(token)
        return token
      },
      hash: (token) => `sha256(${token})`,
    },
    billing: makeBilling(),
    tickets: options.tickets === false ? undefined : makeTickets(),
    deliverMagicLink: async (message) => {
      delivered.push(message)
    },
    audit: async (input) => {
      audits.push(input)
    },
    now: () => NOW,
  })

  return {
    service,
    audits,
    delivered,
    sessionRows,
    identities,
    grants,
    tokens,
    revokeIdentity: (identityId: string) => revoked.add(identityId),
  }
}

function contextFor(
  identityId: string,
  grantRows: PortalGrantRecord[],
  overrides: Partial<PortalContext> = {},
): PortalContext {
  return {
    workspaceId: WS,
    identityId,
    personId: identityId === IDENTITY_A ? PERSON_A : PERSON_B,
    email: `${identityId}@example.com`,
    displayName: null,
    sessionId: `session-${identityId}`,
    grants: grantRows,
    correlationId: "corr-1",
    ...overrides,
  }
}

describe("crm/portal: scope containment", () => {
  let h: Harness
  let ctxA: PortalContext
  let ctxB: PortalContext

  beforeEach(() => {
    h = makeHarness()
    ctxA = contextFor(IDENTITY_A, h.grants[IDENTITY_A] ?? [])
    ctxB = contextFor(IDENTITY_B, h.grants[IDENTITY_B] ?? [])
  })

  test("a list returns only the caller's own records", async () => {
    const listA = await h.service.listInvoices(ctxA, {})
    expect(listA.data.map((row) => row.id).sort()).toEqual(["inv-a", "inv-company"])

    const listB = await h.service.listInvoices(ctxB, {})
    expect(listB.data.map((row) => row.id)).toEqual(["inv-b"])
  })

  test("identity A cannot read identity B's invoice by id — and gets 404, not 403", async () => {
    const attempt = h.service.getInvoice(ctxA, "inv-b")
    await expect(attempt).rejects.toBeInstanceOf(PortalNotFoundError)
    await attempt.catch((err: unknown) => {
      expect((err as { code: string }).code).toBe("NOT_FOUND")
      // The message must not distinguish "exists but not yours" from "gone".
      expect((err as Error).message).toBe("invoice not found")
    })
  })

  test("a denied read is indistinguishable from a read of something that never existed", async () => {
    const foreign = await h.service.getInvoice(ctxA, "inv-b").catch((err: unknown) => err)
    const missing = await h.service
      .getInvoice(ctxA, "inv-does-not-exist")
      .catch((err: unknown) => err)
    expect((foreign as Error).message).toBe((missing as Error).message)
    expect((foreign as { code: string }).code).toBe((missing as { code: string }).code)
  })

  test("identity A cannot read identity B's ticket, by id or through the list", async () => {
    const list = await h.service.listTickets(ctxA, {})
    expect(list.data.map((row) => row.id)).toEqual(["ticket-a"])
    await expect(h.service.getTicket(ctxA, "ticket-b")).rejects.toBeInstanceOf(PortalNotFoundError)
  })

  test("filter parameters cannot widen the scope", async () => {
    // Every one of these is either stripped by the zod schema or narrows the
    // existing predicate. None of them can reach another identity's rows.
    const injected = {
      personId: PERSON_B,
      companyId: COMPANY_A,
      workspaceId: "ws-other",
      ownerId: "member-2",
      status: "sent",
      limit: 100,
    }
    const list = await h.service.listInvoices(ctxB, injected)
    expect(list.data.map((row) => row.id)).toEqual(["inv-b"])
  })

  test("a status filter cannot surface a draft", async () => {
    const list = await h.service.listInvoices(ctxA, { status: "sent" })
    expect(list.data.map((row) => row.id)).toEqual(["inv-a"])
    await expect(h.service.getInvoice(ctxA, "inv-draft")).rejects.toBeInstanceOf(
      PortalNotFoundError,
    )
  })

  test("company-scoped grants reach company records and nothing else", async () => {
    const scope = portalScopeFor(ctxA, "invoice")
    expect(scope.personIds).toEqual([PERSON_A])
    expect(scope.companyIds).toEqual([COMPANY_A])
    const list = await h.service.listInvoices(ctxA, {})
    expect(list.data.some((row) => row.id === "inv-company")).toBe(true)
  })

  test("an identity with no grant for a resource reads nothing, and the scope is empty", async () => {
    const ticketsOnly = contextFor(IDENTITY_A, [
      grant({ canViewInvoices: false, canViewQuotes: false }),
    ])
    const scope = portalScopeFor(ticketsOnly, "invoice")
    expect(scope.personIds).toEqual([])
    expect(scope.companyIds).toEqual([])
    expect((await h.service.listInvoices(ticketsOnly, {})).data).toEqual([])
    await expect(h.service.getInvoice(ticketsOnly, "inv-a")).rejects.toBeInstanceOf(
      PortalNotFoundError,
    )
    // …while the resource it IS entitled to still works.
    expect((await h.service.listTickets(ticketsOnly, {})).data).toHaveLength(1)
  })

  test("an identity with no grants at all reads nothing anywhere", async () => {
    const empty = contextFor(IDENTITY_A, [])
    expect((await h.service.listInvoices(empty, {})).data).toEqual([])
    expect((await h.service.listTickets(empty, {})).data).toEqual([])
    expect((await h.service.listQuotes(empty, {})).data).toEqual([])
  })

  test("the identity's own personId is not implicit access", () => {
    const noGrants = contextFor(IDENTITY_A, [])
    expect(portalScopeFor(noGrants, "invoice").personIds).not.toContain(PERSON_A)
  })
})

describe("crm/portal: internal data never leaves", () => {
  test("a ticket detail drops internal comments and anything that cannot prove it is public", async () => {
    const h = makeHarness()
    const ctxA = contextFor(IDENTITY_A, h.grants[IDENTITY_A] ?? [])
    const ticket = await h.service.getTicket(ctxA, "ticket-a")
    expect(ticket.comments.map((comment) => comment.id)).toEqual(["comment-public"])
    const serialized = JSON.stringify(ticket)
    expect(serialized).not.toContain("churn-risk")
    expect(serialized).not.toContain("JIRA-123")
    expect(serialized).not.toContain("member-1")
    expect(serialized).not.toContain("internalRating")
    expect(serialized).not.toContain(PERSON_A)
  })

  test("an invoice response carries no notes, owner or internal ids", async () => {
    const h = makeHarness()
    const ctxA = contextFor(IDENTITY_A, h.grants[IDENTITY_A] ?? [])
    const invoice = await h.service.getInvoice(ctxA, "inv-a")
    expect(Object.keys(invoice).sort()).toEqual([
      "amountPaidCents",
      "balanceDueCents",
      "currency",
      "dueDate",
      "id",
      "issueDate",
      "lineItems",
      "number",
      "overdue",
      "status",
      "totalCents",
    ])
    const serialized = JSON.stringify(invoice)
    expect(serialized).not.toContain("chase via owner")
    expect(serialized).not.toContain("member-1")
    expect(serialized).not.toContain(WS)
  })
})

describe("crm/portal: magic links resist enumeration", () => {
  test("an unknown address gets the same answer as a known one", async () => {
    const h = makeHarness()
    const known = await h.service.requestMagicLink({ email: "a@example.com" })
    const unknown = await h.service.requestMagicLink({ email: "nobody@example.com" })
    expect(unknown).toEqual(known)
  })

  test("an unknown address produces no link, no delivery and no audit row", async () => {
    const h = makeHarness()
    await h.service.requestMagicLink({ email: "nobody@example.com" })
    expect(h.delivered).toHaveLength(0)
    expect(h.sessionRows).toHaveLength(0)
    expect(h.audits).toHaveLength(0)
  })

  test("an unknown address still burns a token generation, so the paths cost the same", async () => {
    const h = makeHarness()
    await h.service.requestMagicLink({ email: "nobody@example.com" })
    expect(h.tokens).toHaveLength(1)
  })

  test("a revoked identity behaves exactly like an unknown address", async () => {
    const h = makeHarness()
    h.revokeIdentity(IDENTITY_A)
    const result = await h.service.requestMagicLink({ email: "a@example.com" })
    expect(result).toEqual({ requested: true })
    expect(h.delivered).toHaveLength(0)
  })

  test("email casing and padding do not create a second identity", async () => {
    const h = makeHarness()
    await h.service.requestMagicLink({ email: "  A@Example.COM  " })
    expect(h.delivered).toHaveLength(1)
  })

  test("only the hash is stored; the raw token exists solely in the delivered message", async () => {
    const h = makeHarness()
    await h.service.requestMagicLink({ email: "a@example.com" })
    const raw = h.delivered[0]?.token
    expect(raw).toBeDefined()
    expect(h.sessionRows[0]?.tokenHash).toBe(`sha256(${raw})`)
    expect(h.sessionRows.some((row) => row.tokenHash === raw)).toBe(false)
    // The audit trail records that a link was issued, never the secret.
    expect(JSON.stringify(h.audits)).not.toContain(String(raw))
  })
})

describe("crm/portal: sessions", () => {
  test("a magic link works exactly once", async () => {
    const h = makeHarness()
    await h.service.requestMagicLink({ email: "a@example.com" })
    const token = h.delivered[0]?.token ?? ""
    const first = await h.service.exchangeMagicLink({ token })
    expect(first.identity.identityId).toBe(IDENTITY_A)
    await expect(h.service.exchangeMagicLink({ token })).rejects.toBeInstanceOf(
      PortalUnauthorizedError,
    )
  })

  test("an expired link cannot be exchanged", async () => {
    const h = makeHarness()
    await h.service.requestMagicLink({ email: "a@example.com" })
    const row = h.sessionRows[0]
    if (row) row.expiresAt = new Date(NOW.getTime() - 1)
    await expect(
      h.service.exchangeMagicLink({ token: h.delivered[0]?.token ?? "" }),
    ).rejects.toBeInstanceOf(PortalUnauthorizedError)
  })

  test("the session token is a new secret, not the link token", async () => {
    const h = makeHarness()
    await h.service.requestMagicLink({ email: "a@example.com" })
    const linkToken = h.delivered[0]?.token ?? ""
    const session = await h.service.exchangeMagicLink({ token: linkToken })
    expect(session.token).not.toBe(linkToken)
  })

  test("an unexchanged magic-link token is not a session cookie", async () => {
    const h = makeHarness()
    await h.service.requestMagicLink({ email: "a@example.com" })
    const linkToken = h.delivered[0]?.token ?? ""
    expect(await h.service.resolveSession(linkToken)).toBeNull()
  })

  test("a session resolves into a context with grants — and no actor or role", async () => {
    const h = makeHarness()
    await h.service.requestMagicLink({ email: "a@example.com" })
    const granted = await h.service.exchangeMagicLink({ token: h.delivered[0]?.token ?? "" })
    const ctx = await h.service.resolveSession(granted.token, "corr-9")
    expect(ctx?.identityId).toBe(IDENTITY_A)
    expect(ctx?.workspaceId).toBe(WS)
    expect(ctx?.grants).toHaveLength(2)
    expect("actorId" in (ctx ?? {})).toBe(false)
    expect("role" in (ctx ?? {})).toBe(false)
  })

  test("an unknown token, a foreign token and an empty token all resolve to null", async () => {
    const h = makeHarness()
    expect(await h.service.resolveSession("")).toBeNull()
    expect(await h.service.resolveSession("a-member-session-token-0123456789")).toBeNull()
    expect(await h.service.resolveSession("raw-portal-token-999-0123456789abcdef")).toBeNull()
  })

  test("revoking the identity kills its live session immediately", async () => {
    const h = makeHarness()
    await h.service.requestMagicLink({ email: "a@example.com" })
    const granted = await h.service.exchangeMagicLink({ token: h.delivered[0]?.token ?? "" })
    expect(await h.service.resolveSession(granted.token)).not.toBeNull()
    h.revokeIdentity(IDENTITY_A)
    expect(await h.service.resolveSession(granted.token)).toBeNull()
  })

  test("logout revokes the session row", async () => {
    const h = makeHarness()
    await h.service.requestMagicLink({ email: "a@example.com" })
    const granted = await h.service.exchangeMagicLink({ token: h.delivered[0]?.token ?? "" })
    const ctx = await h.service.resolveSession(granted.token)
    expect(ctx).not.toBeNull()
    if (!ctx) return
    await h.service.logout(ctx)
    expect(await h.service.resolveSession(granted.token)).toBeNull()
  })
})

describe("crm/portal: auditability", () => {
  test("login, reads, lists and denials are all audited as external actions", async () => {
    const h = makeHarness()
    await h.service.requestMagicLink({ email: "a@example.com" })
    const granted = await h.service.exchangeMagicLink({ token: h.delivered[0]?.token ?? "" })
    const ctx = await h.service.resolveSession(granted.token, "corr-2")
    if (!ctx) throw new Error("expected a portal context")

    await h.service.listInvoices(ctx, {})
    await h.service.getInvoice(ctx, "inv-a")
    await h.service.getInvoice(ctx, "inv-b").catch(() => undefined)
    await h.service.logout(ctx)

    const actions = h.audits.map((row) => row.action)
    expect(actions).toEqual([
      "portal.magic_link_requested",
      "portal.login",
      "portal.list",
      "portal.read",
      "portal.denied",
      "portal.logout",
    ])
    for (const row of h.audits) {
      expect(row.source).toBe("integration")
      expect(row.actorId).toBe(IDENTITY_A)
      expect(row.workspaceId).toBe(WS)
      expect(row.object.startsWith("portal_")).toBe(true)
    }
  })

  test("the denial audit row records which record was attempted", async () => {
    const h = makeHarness()
    const ctxA = contextFor(IDENTITY_A, h.grants[IDENTITY_A] ?? [])
    await h.service.getInvoice(ctxA, "inv-b").catch(() => undefined)
    const denial = h.audits.find((row) => row.action === "portal.denied")
    expect(denial?.recordId).toBe("inv-b")
    expect(denial?.correlationId).toBe("corr-1")
  })
})

describe("crm/portal: the ticket port is optional and fails closed", () => {
  test("with no support module wired, tickets are empty and unreachable", async () => {
    const h = makeHarness({ tickets: false })
    const ctxA = contextFor(IDENTITY_A, h.grants[IDENTITY_A] ?? [])
    expect((await h.service.listTickets(ctxA, {})).data).toEqual([])
    await expect(h.service.getTicket(ctxA, "ticket-a")).rejects.toBeInstanceOf(PortalNotFoundError)
  })
})
