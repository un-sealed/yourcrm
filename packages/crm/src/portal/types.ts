import type { AuditWriter } from "../ports"

/**
 * Customer portal ports (spec 45-customer-portal, P0).
 *
 * THIS MODULE HAS NO `ServiceContext` AND NO `requirePermission()`.
 * -----------------------------------------------------------------
 * Every other CRM module is called by a workspace member and passes a
 * `ServiceContext { workspaceId, actorId, role }` into `requirePermission()`,
 * which ranks that role. A portal caller is a *customer*: not a user, not a
 * member, no role, nothing for role-rank to compare. Handing the permission
 * policy a fabricated member context would be the single worst thing this
 * module could do, so the context type below deliberately has no `actorId`
 * and no `role` field: a `PortalContext` is not structurally assignable to
 * `ServiceContext`, and the compiler enforces that (see `no-member-surface.test.ts`).
 *
 * What replaces the role check is {@link PortalGrantRecord}: an explicit,
 * per-resource allow-list of `(scopeType, scopeId)` pairs that is compiled
 * into a SQL predicate on every single read. Absence of a grant is denial.
 */

/** Resource kinds the portal can expose (spec 45 §3). */
export const PORTAL_RESOURCES = ["ticket", "invoice", "quote"] as const

export type PortalResource = (typeof PORTAL_RESOURCES)[number]

/**
 * The record keys one portal identity may read, for ONE resource kind.
 *
 * Structurally mirrors `PortalReadScope` in
 * `@yourcrm/database/src/repositories/portal-repository.ts`. The domain
 * package has no database dependency, so the shape is declared on both sides
 * and matched structurally — the same arrangement every other port here uses.
 *
 * An empty scope is legal and means "nothing": the repository renders it as a
 * `false` predicate. It must never be interpreted as "unfiltered".
 */
export type PortalScope = {
  workspaceId: string
  personIds: readonly string[]
  companyIds: readonly string[]
}

export type PortalGrantScopeType = "person" | "company"

/** One row of the identity's allow-list. */
export type PortalGrantRecord = {
  scopeType: PortalGrantScopeType
  scopeId: string
  canViewTickets: boolean
  canViewInvoices: boolean
  canViewQuotes: boolean
}

/** A person who has been granted portal access. Never a `users` row. */
export type PortalIdentityRecord = {
  id: string
  workspaceId: string
  personId: string
  email: string
  displayName?: string | null
}

/** A `portal_sessions` row (either kind), reduced to what the service needs. */
export type PortalSessionRecord = {
  id: string
  workspaceId: string
  portalIdentityId: string
  expiresAt: Date
}

/**
 * The portal's answer to `ServiceContext` — and pointedly not one.
 *
 * No `actorId`, no `role`. Carries the resolved grants so the service can
 * derive a per-resource {@link PortalScope} without a second round trip.
 */
export type PortalContext = {
  workspaceId: string
  /** `portal_identities.id`. NOT a `users.id`. */
  identityId: string
  /** `people.id` this identity speaks for. */
  personId: string
  email: string
  displayName: string | null
  sessionId: string
  grants: readonly PortalGrantRecord[]
  correlationId?: string
}

/* ------------------------------ auth ports ------------------------------ */

export type PortalIdentityStore = {
  /**
   * Login lookup by email, ACROSS workspaces: a magic-link request has no
   * tenant context. Returns every live identity for that address.
   */
  findActiveByEmail(email: string): Promise<PortalIdentityRecord[]>
  findActiveById(workspaceId: string, identityId: string): Promise<PortalIdentityRecord | null>
  listActiveGrants(workspaceId: string, identityId: string): Promise<PortalGrantRecord[]>
  markLogin(workspaceId: string, identityId: string): Promise<void>
}

export type CreatePortalSessionRowInput = {
  workspaceId: string
  portalIdentityId: string
  tokenHash: string
  expiresAt: Date
  userAgent?: string | null
}

export type PortalSessionStore = {
  createMagicLink(input: CreatePortalSessionRowInput): Promise<PortalSessionRecord>
  /**
   * Atomically consume a magic link: implementations MUST do the "unused,
   * unexpired, unrevoked" check inside the UPDATE's WHERE clause and return
   * null when it matched nothing. A read-then-write implementation is a
   * double-redemption bug.
   */
  consumeMagicLink(tokenHash: string): Promise<PortalSessionRecord | null>
  createSession(input: CreatePortalSessionRowInput): Promise<PortalSessionRecord>
  findActiveSession(tokenHash: string): Promise<PortalSessionRecord | null>
  touchSession(sessionId: string): Promise<void>
  revokeSession(workspaceId: string, sessionId: string): Promise<void>
}

/**
 * CSPRNG token generation + hashing. Bound by the API layer to
 * `generateSessionToken` / `hashSessionToken` from `@yourcrm/auth` — the
 * portal does not invent its own crypto, and `@yourcrm/crm` does not take a
 * dependency on the auth package to say so.
 */
export type PortalTokenPort = {
  generate(): string
  hash(token: string): string
}

/** What the customer receives. The raw token exists here and nowhere else. */
export type PortalMagicLinkMessage = {
  email: string
  token: string
  expiresAt: Date
  workspaceId: string
  identityId: string
  displayName: string | null
}

export type PortalMagicLinkDelivery = (message: PortalMagicLinkMessage) => Promise<void>

/* ------------------------------ read ports ------------------------------ */

/** Pass-through source row. Redacted into a DTO before it can leave. */
export type PortalSourceRecord = Record<string, unknown> & { id: string }

export type PortalPage<T> = {
  data: T[]
  pagination: { nextCursor: string | null; limit: number }
}

export type PortalReadQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  status?: string
}

export type PortalInvoiceDetailSource = {
  invoice: PortalSourceRecord
  lineItems: PortalSourceRecord[]
  /** Aggregate only — payment rows carry internal references and notes. */
  amountPaidCents: number
}

export type PortalQuoteDetailSource = {
  quote: PortalSourceRecord
  lineItems: PortalSourceRecord[]
}

/**
 * Invoices + quotes, scoped. Note the shape of every method: the scope is the
 * FIRST argument and there is no overload without it, so there is no way to
 * ask this port for "an invoice by id" without saying whose it must be.
 */
export type PortalBillingReader = {
  listInvoices(scope: PortalScope, query: PortalReadQuery): Promise<PortalPage<PortalSourceRecord>>
  findInvoice(scope: PortalScope, invoiceId: string): Promise<PortalInvoiceDetailSource | null>
  listQuotes(scope: PortalScope, query: PortalReadQuery): Promise<PortalPage<PortalSourceRecord>>
  findQuote(scope: PortalScope, quoteId: string): Promise<PortalQuoteDetailSource | null>
}

export type PortalTicketDetailSource = {
  ticket: PortalSourceRecord
  /**
   * ALL comments on the ticket, public and internal. This module filters
   * them (see `isPublicPortalComment`) and treats anything whose visibility
   * it cannot positively read as internal.
   */
  comments: PortalSourceRecord[]
}

/**
 * Tickets, scoped.
 *
 * The support module (spec 21) is built on another branch and owns the
 * `tickets` tables, so this module never imports it and never assumes its
 * column names. `ticketId` is an opaque uuid. The integrator binds this port
 * to a support-side reader whose implementation MUST apply `scope` in SQL
 * exactly the way `portalScopeCondition` does for invoices and quotes.
 *
 * Until then the port is simply absent and every ticket endpoint answers
 * "you have no tickets" / 404 — never an unscoped read.
 */
export type PortalTicketReader = {
  list(scope: PortalScope, query: PortalReadQuery): Promise<PortalPage<PortalSourceRecord>>
  findById(scope: PortalScope, ticketId: string): Promise<PortalTicketDetailSource | null>
}

/* --------------------------------- audit -------------------------------- */

/**
 * Structural mirror of `WriteAuditInput` (no database import here).
 *
 * Portal rows always use `source: "integration"`: the actor is external to
 * the workspace, so conflating it with `"user"` (which every audit consumer
 * reads as "a member did this") would be a lie. `actorId` is a
 * `portal_identities.id` and `object` is always `portal_*`, so no consumer
 * can mistake a customer for a member.
 */
export type PortalAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type PortalServiceDeps = {
  identities: PortalIdentityStore
  sessions: PortalSessionStore
  tokens: PortalTokenPort
  billing: PortalBillingReader
  /** Absent until the support module is wired — see {@link PortalTicketReader}. */
  tickets?: PortalTicketReader
  deliverMagicLink: PortalMagicLinkDelivery
  audit: AuditWriter<PortalAuditInput>
  /** Injectable clock so expiry is testable without sleeping. */
  now?: () => Date
  magicLinkTtlMs?: number
  sessionTtlMs?: number
  /** Hard cap on links mailed for one address (one live identity per tenant). */
  maxIdentitiesPerEmail?: number
}
