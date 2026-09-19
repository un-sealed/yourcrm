import {
  portalInvoiceQuerySchema,
  portalMagicLinkRequestSchema,
  portalQuoteQuerySchema,
  portalSessionExchangeSchema,
  portalTicketQuerySchema,
  type PortalIdentityDto,
} from "./schemas"
import {
  toPortalInvoiceDetail,
  toPortalInvoiceSummary,
  toPortalQuoteDetail,
  toPortalQuoteSummary,
  toPortalTicketDetail,
  toPortalTicketSummary,
  type PortalInvoiceDto,
  type PortalQuoteDto,
  type PortalTicketDto,
} from "./redact"
import type {
  PortalAuditInput,
  PortalContext,
  PortalGrantRecord,
  PortalIdentityRecord,
  PortalPage,
  PortalResource,
  PortalScope,
  PortalServiceDeps,
} from "./types"

/**
 * Customer portal domain service (spec 45-customer-portal, P0).
 *
 * HOW THIS DIFFERS FROM EVERY OTHER SERVICE IN `@yourcrm/crm`
 * -----------------------------------------------------------
 * The people service — the reference every module copies — starts each
 * method with `requirePermission()` over the caller's workspace role. This
 * file does not, cannot and must not, and that is not a shortcut:
 *
 *   - There is no role. The caller is a customer, not a member. Feeding
 *     `@yourcrm/permissions` a synthesised `{ role: "viewer" }` would make a
 *     stranger pass every `read` check in the system, because the foundation
 *     policy ranks roles and `viewer` outranks the `read` threshold.
 *   - So this module never imports `@yourcrm/permissions`, never takes a
 *     `ServiceContext`, and its {@link PortalContext} has no `actorId` and no
 *     `role` — it is not assignable to `ServiceContext`, by construction.
 *     `no-member-surface.test.ts` fails the build if that stops being true.
 *
 * WHAT ENFORCES ACCESS INSTEAD
 * ----------------------------
 * {@link portalScopeFor} turns the identity's live grants into a
 * {@link PortalScope} for one resource kind, and that scope is the first
 * argument of every read port. The repository compiles it into the WHERE
 * clause (`workspace_id = $ws AND deleted_at IS NULL AND (person_id IN … OR
 * company_id IN …)`). Consequences worth stating out loud:
 *
 *   - An identity with no grant for a resource gets an EMPTY scope, and an
 *     empty scope is a `false` predicate — not an unfiltered query. The
 *     no-entitlement path is therefore the SAME code path as the normal one,
 *     with an empty list. There is no `if (allowed)` branch to get wrong.
 *   - A record that exists but belongs to somebody else is indistinguishable
 *     from one that does not exist: both come back `null` and both raise
 *     {@link PortalNotFoundError}. The portal never answers 403 — a 403 is a
 *     confirmation that the record exists.
 *
 * AUDIT
 * -----
 * Every externally triggered action writes an audit row: link requested,
 * logged in, logged out, list read, record read, and every denial. Rows use
 * `source: "integration"` with `actorId = portal_identities.id`, so nothing
 * downstream can mistake a customer for a member.
 *
 * EVENTS — BLOCKER, DELIBERATELY UNWIRED
 * --------------------------------------
 * Spec 45 §9 asks for `portal.login`, `portal.quote_accepted` and
 * `portal.ticket_created`. `@yourcrm/events` has no portal event group, and
 * emitting a string literal would defeat the constant registry that keeps
 * event names reviewable. So this module emits NO domain events and has no
 * event port. Adding `PortalEvents` to `packages/events/src/envelope.ts` is
 * the integrator's call; the audit trail above covers the P0 requirement in
 * the meantime.
 */

/** Magic links are short-lived by design: minutes, not hours. */
export const PORTAL_MAGIC_LINK_TTL_MS = 15 * 60 * 1000

/** Portal sessions are far shorter than the 30-day member session. */
export const PORTAL_SESSION_TTL_MS = 12 * 60 * 60 * 1000

export const PORTAL_MAX_IDENTITIES_PER_EMAIL = 10

/**
 * Raised for absent, soft-deleted, out-of-scope and not-yet-visible records
 * alike. The message never names which of those it was.
 */
export class PortalNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(resource: string) {
    super(`${resource} not found`)
    this.name = "PortalNotFoundError"
  }
}

/** No portal session, or one that has expired, been revoked or been consumed. */
export class PortalUnauthorizedError extends Error {
  readonly code = "UNAUTHORIZED"
  constructor(message = "Portal authentication required") {
    super(message)
    this.name = "PortalUnauthorizedError"
  }
}

function grantAllows(grant: PortalGrantRecord, resource: PortalResource): boolean {
  if (resource === "ticket") return grant.canViewTickets
  if (resource === "invoice") return grant.canViewInvoices
  return grant.canViewQuotes
}

/**
 * Compile the identity's grants into the SQL scope for one resource kind.
 *
 * Only grants that explicitly allow this resource contribute. The identity's
 * own `personId` is NOT added implicitly: access is exactly what was granted,
 * so revoking the last grant really does revoke everything.
 */
export function portalScopeFor(ctx: PortalContext, resource: PortalResource): PortalScope {
  const personIds: string[] = []
  const companyIds: string[] = []
  for (const grant of ctx.grants) {
    if (!grantAllows(grant, resource)) continue
    if (grant.scopeType === "person") personIds.push(grant.scopeId)
    else companyIds.push(grant.scopeId)
  }
  return {
    workspaceId: ctx.workspaceId,
    personIds: [...new Set(personIds)],
    companyIds: [...new Set(companyIds)],
  }
}

function entitlementsOf(grants: readonly PortalGrantRecord[]) {
  return {
    tickets: grants.some((grant) => grant.canViewTickets),
    invoices: grants.some((grant) => grant.canViewInvoices),
    quotes: grants.some((grant) => grant.canViewQuotes),
  }
}

function identityDto(
  identity: PortalIdentityRecord,
  grants: readonly PortalGrantRecord[],
): PortalIdentityDto {
  return {
    identityId: identity.id,
    email: identity.email,
    displayName: identity.displayName ?? null,
    entitlements: entitlementsOf(grants),
  }
}

export type PortalSessionGrantResult = {
  /** Raw session token. Set as an httpOnly cookie by the API; never stored. */
  token: string
  expiresAt: Date
  identity: PortalIdentityDto
}

export type PortalRequestMeta = {
  userAgent?: string | null
  correlationId?: string | null
}

export function createPortalService(deps: PortalServiceDeps) {
  const now = deps.now ?? (() => new Date())
  const magicLinkTtlMs = deps.magicLinkTtlMs ?? PORTAL_MAGIC_LINK_TTL_MS
  const sessionTtlMs = deps.sessionTtlMs ?? PORTAL_SESSION_TTL_MS
  const maxIdentities = deps.maxIdentitiesPerEmail ?? PORTAL_MAX_IDENTITIES_PER_EMAIL

  async function audit(input: Omit<PortalAuditInput, "source">): Promise<void> {
    await deps.audit({ ...input, source: "integration" })
  }

  /* ------------------------------- auth -------------------------------- */

  /**
   * Request a magic link.
   *
   * ENUMERATION RESISTANCE IS THE WHOLE CONTRACT OF THIS METHOD. The return
   * value is the same object for a known address, an unknown address, a
   * revoked identity and an expired one, and the caller (the route) turns all
   * of them into the same 202. It also performs the same token generation and
   * hashing work in the unknown-address branch, so the two paths do not
   * differ by a measurable amount of crypto either.
   *
   * No audit row is written for an unknown address: there is no workspace to
   * attach it to, and inventing one would be the leak in a different place.
   */
  async function requestMagicLink(
    rawInput: unknown,
    meta: PortalRequestMeta = {},
  ): Promise<{ requested: true }> {
    const input = portalMagicLinkRequestSchema.parse(rawInput)
    const identities = await deps.identities.findActiveByEmail(input.email)

    // Same work on both branches (see above). Discarded when nothing matched.
    const decoy = deps.tokens.hash(deps.tokens.generate())
    if (identities.length === 0) {
      void decoy
      return { requested: true }
    }

    const expiresAt = new Date(now().getTime() + magicLinkTtlMs)
    for (const identity of identities.slice(0, maxIdentities)) {
      const token = deps.tokens.generate()
      await deps.sessions.createMagicLink({
        workspaceId: identity.workspaceId,
        portalIdentityId: identity.id,
        tokenHash: deps.tokens.hash(token),
        expiresAt,
        userAgent: meta.userAgent ?? null,
      })
      await deps.deliverMagicLink({
        email: identity.email,
        token,
        expiresAt,
        workspaceId: identity.workspaceId,
        identityId: identity.id,
        displayName: identity.displayName ?? null,
      })
      await audit({
        workspaceId: identity.workspaceId,
        actorId: identity.id,
        action: "portal.magic_link_requested",
        object: "portal_identity",
        recordId: identity.id,
        // Never the token, never its hash.
        after: { expiresAt: expiresAt.toISOString() },
        correlationId: meta.correlationId ?? null,
      })
    }
    return { requested: true }
  }

  /**
   * Exchange a magic link for a portal session.
   *
   * Single use is the database's job (`consumeMagicLink` is an atomic UPDATE
   * … RETURNING), so replaying a link — even concurrently — yields exactly
   * one session. The session token is a NEW secret: the link token is never
   * reused as a session credential.
   */
  async function exchangeMagicLink(
    rawInput: unknown,
    meta: PortalRequestMeta = {},
  ): Promise<PortalSessionGrantResult> {
    const input = portalSessionExchangeSchema.parse(rawInput)
    const pending = await deps.sessions.consumeMagicLink(deps.tokens.hash(input.token))
    if (!pending) throw new PortalUnauthorizedError("This link is invalid or has expired.")

    const identity = await deps.identities.findActiveById(
      pending.workspaceId,
      pending.portalIdentityId,
    )
    // Access revoked between issuing the link and clicking it.
    if (!identity) throw new PortalUnauthorizedError("This link is invalid or has expired.")

    const token = deps.tokens.generate()
    const expiresAt = new Date(now().getTime() + sessionTtlMs)
    const session = await deps.sessions.createSession({
      workspaceId: identity.workspaceId,
      portalIdentityId: identity.id,
      tokenHash: deps.tokens.hash(token),
      expiresAt,
      userAgent: meta.userAgent ?? null,
    })
    await deps.identities.markLogin(identity.workspaceId, identity.id)
    const grants = await deps.identities.listActiveGrants(identity.workspaceId, identity.id)
    await audit({
      workspaceId: identity.workspaceId,
      actorId: identity.id,
      action: "portal.login",
      object: "portal_session",
      recordId: session.id,
      after: { expiresAt: expiresAt.toISOString(), entitlements: entitlementsOf(grants) },
      correlationId: meta.correlationId ?? null,
    })
    return { token, expiresAt, identity: identityDto(identity, grants) }
  }

  /**
   * Resolve a raw portal cookie into a {@link PortalContext}, or null.
   *
   * This looks ONLY in `portal_sessions`. A member session token presented
   * here hashes to something that is not in that table and resolves to null —
   * and symmetrically, `@yourcrm/auth`'s resolver only looks in `sessions`,
   * so a portal token cannot log anybody into the CRM. The two token spaces
   * never meet.
   */
  async function resolveSession(
    rawToken: string,
    correlationId?: string,
  ): Promise<PortalContext | null> {
    if (!rawToken) return null
    const session = await deps.sessions.findActiveSession(deps.tokens.hash(rawToken))
    if (!session) return null
    const identity = await deps.identities.findActiveById(
      session.workspaceId,
      session.portalIdentityId,
    )
    // Identity revoked/expired since the session was issued: session is dead.
    if (!identity) return null
    const grants = await deps.identities.listActiveGrants(identity.workspaceId, identity.id)
    await deps.sessions.touchSession(session.id)
    return {
      workspaceId: identity.workspaceId,
      identityId: identity.id,
      personId: identity.personId,
      email: identity.email,
      displayName: identity.displayName ?? null,
      sessionId: session.id,
      grants,
      correlationId,
    }
  }

  async function logout(ctx: PortalContext): Promise<void> {
    await deps.sessions.revokeSession(ctx.workspaceId, ctx.sessionId)
    await audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.identityId,
      action: "portal.logout",
      object: "portal_session",
      recordId: ctx.sessionId,
      correlationId: ctx.correlationId ?? null,
    })
  }

  function me(ctx: PortalContext): PortalIdentityDto {
    return {
      identityId: ctx.identityId,
      email: ctx.email,
      displayName: ctx.displayName,
      entitlements: entitlementsOf(ctx.grants),
    }
  }

  /* ------------------------------- reads -------------------------------- */

  async function auditList(ctx: PortalContext, object: string, count: number): Promise<void> {
    await audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.identityId,
      action: "portal.list",
      object,
      after: { count },
      correlationId: ctx.correlationId ?? null,
    })
  }

  async function auditRead(ctx: PortalContext, object: string, recordId: string): Promise<void> {
    await audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.identityId,
      action: "portal.read",
      object,
      recordId,
      correlationId: ctx.correlationId ?? null,
    })
  }

  /** Out-of-scope or unknown id. Audited: this is the interesting one. */
  async function denied(ctx: PortalContext, object: string, recordId: string): Promise<never> {
    await audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.identityId,
      action: "portal.denied",
      object,
      recordId,
      correlationId: ctx.correlationId ?? null,
    })
    throw new PortalNotFoundError(object.replace("portal_", ""))
  }

  async function listInvoices(
    ctx: PortalContext,
    rawQuery: unknown,
  ): Promise<PortalPage<PortalInvoiceDto>> {
    const query = portalInvoiceQuerySchema.parse(rawQuery)
    const page = await deps.billing.listInvoices(portalScopeFor(ctx, "invoice"), query)
    const data = page.data.map((row) => toPortalInvoiceSummary(row, now()))
    await auditList(ctx, "portal_invoice", data.length)
    return { data, pagination: page.pagination }
  }

  async function getInvoice(ctx: PortalContext, invoiceId: string): Promise<PortalInvoiceDto> {
    const found = await deps.billing.findInvoice(portalScopeFor(ctx, "invoice"), invoiceId)
    if (!found) return denied(ctx, "portal_invoice", invoiceId)
    await auditRead(ctx, "portal_invoice", invoiceId)
    return toPortalInvoiceDetail(found.invoice, found.lineItems, found.amountPaidCents, now())
  }

  async function listQuotes(
    ctx: PortalContext,
    rawQuery: unknown,
  ): Promise<PortalPage<PortalQuoteDto>> {
    const query = portalQuoteQuerySchema.parse(rawQuery)
    const page = await deps.billing.listQuotes(portalScopeFor(ctx, "quote"), query)
    const data = page.data.map(toPortalQuoteSummary)
    await auditList(ctx, "portal_quote", data.length)
    return { data, pagination: page.pagination }
  }

  async function getQuote(ctx: PortalContext, quoteId: string): Promise<PortalQuoteDto> {
    const found = await deps.billing.findQuote(portalScopeFor(ctx, "quote"), quoteId)
    if (!found) return denied(ctx, "portal_quote", quoteId)
    await auditRead(ctx, "portal_quote", quoteId)
    return toPortalQuoteDetail(found.quote, found.lineItems)
  }

  /**
   * Tickets come from an injected reader owned by the support module. When it
   * is not wired the portal reports "no tickets" rather than failing open.
   */
  async function listTickets(
    ctx: PortalContext,
    rawQuery: unknown,
  ): Promise<PortalPage<PortalTicketDto>> {
    const query = portalTicketQuerySchema.parse(rawQuery)
    const page = (await deps.tickets?.list(portalScopeFor(ctx, "ticket"), query)) ?? {
      data: [],
      pagination: { nextCursor: null, limit: query.limit },
    }
    const data = page.data.map(toPortalTicketSummary)
    await auditList(ctx, "portal_ticket", data.length)
    return { data, pagination: page.pagination }
  }

  async function getTicket(ctx: PortalContext, ticketId: string): Promise<PortalTicketDto> {
    const found = await deps.tickets?.findById(portalScopeFor(ctx, "ticket"), ticketId)
    if (!found) return denied(ctx, "portal_ticket", ticketId)
    await auditRead(ctx, "portal_ticket", ticketId)
    return toPortalTicketDetail(found.ticket, found.comments)
  }

  return {
    requestMagicLink,
    exchangeMagicLink,
    resolveSession,
    logout,
    me,
    listInvoices,
    getInvoice,
    listQuotes,
    getQuote,
    listTickets,
    getTicket,
  }
}

export type PortalService = ReturnType<typeof createPortalService>
