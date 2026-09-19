import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, sum, type SQL } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import type { Database } from "../client"
import { invoiceLineItems, invoices, payments } from "../schema/invoices"
import {
  portalAccessGrants,
  portalIdentities,
  portalSessions,
  type PortalIdentityRow,
  type PortalSessionRow,
} from "../schema/portal"
import { quoteLineItems, quotes } from "../schema/quotes"

/**
 * Customer portal repository (spec 45-customer-portal, P0).
 *
 * SCOPE CONTAINMENT IS THIS FILE'S ONLY REAL JOB.
 * -----------------------------------------------
 * The caller of these reads is not a workspace member. There is no role to
 * rank and no `requirePermission()` to fall back on, so the *query itself*
 * has to be the permission check. Two rules make that true here, and both are
 * mechanical:
 *
 *  1. Every customer-facing read goes through {@link portalScopeCondition},
 *     which ANDs `workspace_id`, `deleted_at IS NULL` and
 *     `(person_id IN scope OR company_id IN scope)` into the WHERE clause.
 *     It is not an option and it is never applied after the fact in
 *     JavaScript — an empty scope renders as literal `false`, so the
 *     degenerate case returns zero rows instead of everything.
 *
 *  2. Child rows (line items, payments) are never fetched by parent id alone.
 *     They JOIN their parent and the parent carries the scope condition, so
 *     guessing an invoice id gets you an empty array, not somebody's prices.
 *
 * Detail reads return `null` for "absent", "soft-deleted", "not yours" and
 * "not a portal-visible status" alike. The route turns all four into 404 —
 * the portal never answers 403, because 403 confirms the row exists.
 *
 * DRAFTS ARE NOT CUSTOMER DATA. `status` filters below keep unsent invoices
 * and quotes out of the portal in SQL, not in the view layer.
 */

/**
 * The complete set of records a portal identity may read, resolved from its
 * live `portal_access_grants` rows for ONE resource kind.
 *
 * Structurally mirrored by `PortalScope` in `@yourcrm/crm`'s portal module
 * (the domain package has no database dependency, so the shape is declared on
 * both sides and matched structurally — same arrangement as every other port
 * in this repo).
 */
export type PortalReadScope = {
  workspaceId: string
  personIds: readonly string[]
  companyIds: readonly string[]
}

/** Invoice statuses a customer may see. `draft` and `void` are internal. */
export const PORTAL_VISIBLE_INVOICE_STATUSES = ["sent", "paid"] as const

/** Quote statuses a customer may see. `draft` is internal. */
export const PORTAL_VISIBLE_QUOTE_STATUSES = ["sent", "accepted", "rejected"] as const

export const PORTAL_LIST_MAX_LIMIT = 100

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class InvalidPortalCursorError extends Error {
  readonly code = "VALIDATION_ERROR"
  constructor(message = "cursor is not a valid cursor token") {
    super(message)
    this.name = "InvalidPortalCursorError"
  }
}

/** Keyset cursor over `(created_at, id)` — stable under concurrent inserts. */
export function encodePortalCursor(createdAt: Date, id: string): string {
  const raw = `${createdAt.toISOString()}|${id}`
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

export function decodePortalCursor(cursor?: string | null): { createdAt: Date; id: string } | null {
  if (cursor === null || cursor === undefined || cursor === "") return null
  let raw: string
  try {
    raw = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))
  } catch {
    throw new InvalidPortalCursorError()
  }
  const at = raw.indexOf("|")
  if (at < 0) throw new InvalidPortalCursorError()
  const createdAt = new Date(raw.slice(0, at))
  const id = raw.slice(at + 1)
  if (Number.isNaN(createdAt.getTime()) || !UUID_RE.test(id)) throw new InvalidPortalCursorError()
  return { createdAt, id }
}

/** Emails are stored and compared trimmed + lowercased. */
export function normalizePortalEmail(email: string): string {
  return email.trim().toLowerCase()
}

type ScopedColumns = {
  workspaceId: PgColumn
  deletedAt: PgColumn
  personId: PgColumn
  companyId: PgColumn
}

/**
 * The portal's entire authorization model, as one SQL predicate.
 *
 * `workspace_id = $ws AND deleted_at IS NULL AND (person_id IN $people OR
 * company_id IN $companies)`.
 *
 * With an empty scope both `IN` lists render as the literal `false` (drizzle's
 * documented behaviour for `inArray(col, [])`), so the predicate is
 * `... AND (false OR false)` and the query returns nothing. That is the
 * fail-closed property the whole module depends on: an identity whose grants
 * were all revoked reads zero rows rather than every row.
 */
export function portalScopeCondition(cols: ScopedColumns, scope: PortalReadScope): SQL {
  const owned = or(
    inArray(cols.personId, [...scope.personIds]),
    inArray(cols.companyId, [...scope.companyIds]),
  )
  const condition = and(eq(cols.workspaceId, scope.workspaceId), isNull(cols.deletedAt), owned)
  // `and()` is only undefined for an empty argument list; keep the type honest
  // without a non-null assertion so this can never silently become `WHERE true`.
  if (!condition) throw new Error("portal.scope: empty scope condition")
  return condition
}

function invoiceScope(scope: PortalReadScope): SQL {
  return portalScopeCondition(
    {
      workspaceId: invoices.workspaceId,
      deletedAt: invoices.deletedAt,
      personId: invoices.personId,
      companyId: invoices.companyId,
    },
    scope,
  )
}

function quoteScope(scope: PortalReadScope): SQL {
  return portalScopeCondition(
    {
      workspaceId: quotes.workspaceId,
      deletedAt: quotes.deletedAt,
      personId: quotes.personId,
      companyId: quotes.companyId,
    },
    scope,
  )
}

/**
 * Column allow-lists. Explicit projections, never `select()`: a new internal
 * column added to `invoices` or `quotes` by another module must not appear in
 * a customer response just because it was added. `notes`, `owner_id`,
 * `created_by`, `updated_by`, `deal_id` and the raw `person_id`/`company_id`
 * links are all deliberately absent.
 */
const portalInvoiceColumns = {
  id: invoices.id,
  number: invoices.number,
  status: invoices.status,
  currency: invoices.currency,
  issueDate: invoices.issueDate,
  dueDate: invoices.dueDate,
  createdAt: invoices.createdAt,
}

const portalQuoteColumns = {
  id: quotes.id,
  number: quotes.number,
  status: quotes.status,
  currency: quotes.currency,
  expiresAt: quotes.expiresAt,
  discountType: quotes.discountType,
  discountValue: quotes.discountValue,
  taxRateBps: quotes.taxRateBps,
  // Terms are the customer-facing half of a quote document; `notes` is not.
  terms: quotes.terms,
  createdAt: quotes.createdAt,
}

const portalLineItemColumns = {
  id: invoiceLineItems.id,
  description: invoiceLineItems.description,
  quantity: invoiceLineItems.quantity,
  unitAmountCents: invoiceLineItems.unitAmountCents,
  position: invoiceLineItems.position,
}

const portalQuoteLineItemColumns = {
  id: quoteLineItems.id,
  description: quoteLineItems.description,
  quantity: quoteLineItems.quantity,
  unitAmountCents: quoteLineItems.unitAmountCents,
  position: quoteLineItems.position,
}

/**
 * Correlated money aggregates for list rows.
 *
 * The customer needs an amount next to each invoice, and fetching line items
 * per row would be N+1. These subqueries are bounded by the OUTER row's id,
 * and that outer row has already passed {@link portalScopeCondition} — a
 * subquery cannot reach a record the outer query was not allowed to return.
 *
 * `::bigint` rather than `::int`: individual amounts fit in int4, a SUM of
 * them need not. postgres.js hands bigints back as strings, so every value
 * goes through {@link toCents}.
 *
 * THE CORRELATION IS WRITTEN OUT AS `"invoices"."id"`, NOT INTERPOLATED.
 * Drizzle renders a column placed in a SELECT list unqualified (`"id"`), and
 * an unqualified `"id"` inside these subqueries binds to the SUBQUERY's table
 * — `li.invoice_id = li.id` — which silently matches nothing and reports
 * every total as zero. `portal-repository.test.ts` asserts the qualified form
 * is still there.
 */
const invoiceTotalCentsSql = sql<string>`COALESCE((
  SELECT SUM(li.quantity * li.unit_amount_cents)
  FROM invoice_line_items li
  WHERE li.invoice_id = "invoices"."id" AND li.deleted_at IS NULL
), 0)::bigint`

const invoicePaidCentsSql = sql<string>`COALESCE((
  SELECT SUM(p.amount_cents)
  FROM payments p
  WHERE p.invoice_id = "invoices"."id" AND p.deleted_at IS NULL
), 0)::bigint`

const quoteSubtotalCentsSql = sql<string>`COALESCE((
  SELECT SUM(qli.quantity * qli.unit_amount_cents)
  FROM quote_line_items qli
  WHERE qli.quote_id = "quotes"."id" AND qli.deleted_at IS NULL
), 0)::bigint`

/** Coerce a bigint-as-string (or number, or null) to an integer cent count. */
export function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

export type PortalInvoiceListRow = {
  id: string
  number: string
  status: string
  currency: string
  issueDate: string | null
  dueDate: string | null
  createdAt: Date
  /** Σ line items. Derived, never stored (same rule as the invoices module). */
  totalCents: number
  /** Σ recorded payments. The payment rows themselves stay internal. */
  paidCents: number
}

export type PortalQuoteListRow = {
  id: string
  number: string
  status: string
  currency: string
  expiresAt: string | null
  discountType: string
  discountValue: number
  taxRateBps: number
  terms: string | null
  createdAt: Date
  /** Σ line items, before discount and tax. Derived, never stored. */
  subtotalCents: number
}

export type PortalLineItemRow = {
  id: string
  description: string
  quantity: number
  unitAmountCents: number
  position: number
}

export type PortalListOptions = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  status?: string
}

export type PortalPage<T> = {
  data: T[]
  pagination: { nextCursor: string | null; limit: number }
}

function pageLimit(limit?: number): number {
  return Math.min(Math.max(limit ?? 25, 1), PORTAL_LIST_MAX_LIMIT)
}

/** Keyset predicate for `(created_at, id)` in the requested direction. */
function cursorCondition(
  createdAtColumn: PgColumn,
  idColumn: PgColumn,
  cursor: { createdAt: Date; id: string } | null,
  order: "asc" | "desc",
): SQL | null {
  if (!cursor) return null
  const compare = order === "asc" ? gt : lt
  const after = or(
    compare(createdAtColumn, cursor.createdAt),
    and(eq(createdAtColumn, cursor.createdAt), compare(idColumn, cursor.id)),
  )
  return after ?? null
}

function nextCursorOf<T extends { id: string; createdAt: Date }>(
  rows: T[],
  hasMore: boolean,
): string | null {
  if (!hasMore) return null
  const last = rows[rows.length - 1]
  return last ? encodePortalCursor(last.createdAt, last.id) : null
}

/** `col IS NULL OR col > now` — "not expired", as one non-optional SQL node. */
function notExpired(column: PgColumn, now: Date): SQL {
  const condition = or(isNull(column), gt(column, now))
  if (!condition) throw new Error("portal.notExpired: empty condition")
  return condition
}

/** An identity may authenticate only while live, unrevoked and unexpired. */
function liveIdentityConditions(now: Date): SQL[] {
  return [
    isNull(portalIdentities.deletedAt),
    isNull(portalIdentities.revokedAt),
    eq(portalIdentities.status, "active"),
    notExpired(portalIdentities.expiresAt, now),
  ]
}

export type CreatePortalIdentityInput = {
  personId: string
  email: string
  displayName?: string | null
  expiresAt?: Date | null
}

export type CreatePortalGrantInput = {
  portalIdentityId: string
  scopeType: "person" | "company"
  scopeId: string
  canViewTickets?: boolean
  canViewInvoices?: boolean
  canViewQuotes?: boolean
  expiresAt?: Date | null
}

export type CreatePortalSessionInput = {
  workspaceId: string
  portalIdentityId: string
  tokenHash: string
  expiresAt: Date
  userAgent?: string | null
}

/**
 * Portal persistence + the scoped customer-facing reads.
 *
 * Every read below takes a {@link PortalReadScope} rather than an id plus a
 * workspace: it is not possible to call one of these functions in a way that
 * forgets the scope, because there is no overload that omits it.
 */
export function createPortalRepository() {
  return {
    /* ----------------------------- identities ---------------------------- */

    /**
     * Login lookup. Deliberately NOT workspace-scoped: a magic-link request
     * arrives from somebody who is not signed in and has no tenant context,
     * so the email is the only key available. One live identity per workspace
     * may match; the caller mails one link per match, and each link binds to
     * exactly one identity (and therefore one workspace).
     */
    async findActiveIdentitiesByEmail(
      db: Database,
      email: string,
      now = new Date(),
      limit = 10,
    ): Promise<PortalIdentityRow[]> {
      return db
        .select()
        .from(portalIdentities)
        .where(
          and(
            eq(portalIdentities.email, normalizePortalEmail(email)),
            ...liveIdentityConditions(now),
          ),
        )
        .orderBy(asc(portalIdentities.createdAt))
        .limit(limit)
    },

    async findActiveIdentityById(
      db: Database,
      workspaceId: string,
      id: string,
      now = new Date(),
    ): Promise<PortalIdentityRow | null> {
      const rows = await db
        .select()
        .from(portalIdentities)
        .where(
          and(
            eq(portalIdentities.id, id),
            eq(portalIdentities.workspaceId, workspaceId),
            ...liveIdentityConditions(now),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    async createIdentity(
      db: Database,
      workspaceId: string,
      input: CreatePortalIdentityInput,
      actorId?: string,
    ): Promise<PortalIdentityRow> {
      const rows = await db
        .insert(portalIdentities)
        .values({
          workspaceId,
          personId: input.personId,
          email: normalizePortalEmail(input.email),
          displayName: input.displayName ?? null,
          expiresAt: input.expiresAt ?? null,
          createdBy: actorId ?? null,
          updatedBy: actorId ?? null,
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("portal.createIdentity: insert returned no row")
      return row
    },

    /** Access revocation (spec 45 §3): identity off, every live session off. */
    async revokeIdentity(
      db: Database,
      workspaceId: string,
      id: string,
      now = new Date(),
      actorId?: string,
    ): Promise<void> {
      await db
        .update(portalIdentities)
        .set({ status: "revoked", revokedAt: now, updatedAt: now, updatedBy: actorId ?? null })
        .where(and(eq(portalIdentities.id, id), eq(portalIdentities.workspaceId, workspaceId)))
      await db
        .update(portalSessions)
        .set({ revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(portalSessions.portalIdentityId, id),
            eq(portalSessions.workspaceId, workspaceId),
            isNull(portalSessions.revokedAt),
          ),
        )
    },

    async markIdentityLogin(
      db: Database,
      workspaceId: string,
      id: string,
      now = new Date(),
    ): Promise<void> {
      await db
        .update(portalIdentities)
        .set({ lastLoginAt: now, updatedAt: now })
        .where(and(eq(portalIdentities.id, id), eq(portalIdentities.workspaceId, workspaceId)))
    },

    /* ------------------------------- grants ------------------------------ */

    async createGrant(
      db: Database,
      workspaceId: string,
      input: CreatePortalGrantInput,
      actorId?: string,
    ) {
      const rows = await db
        .insert(portalAccessGrants)
        .values({
          workspaceId,
          portalIdentityId: input.portalIdentityId,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          canViewTickets: input.canViewTickets ?? false,
          canViewInvoices: input.canViewInvoices ?? false,
          canViewQuotes: input.canViewQuotes ?? false,
          expiresAt: input.expiresAt ?? null,
          createdBy: actorId ?? null,
          updatedBy: actorId ?? null,
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("portal.createGrant: insert returned no row")
      return row
    },

    /** Live grants only: not deleted, not revoked, not expired. */
    async listActiveGrants(
      db: Database,
      workspaceId: string,
      portalIdentityId: string,
      now = new Date(),
    ) {
      return db
        .select()
        .from(portalAccessGrants)
        .where(
          and(
            eq(portalAccessGrants.workspaceId, workspaceId),
            eq(portalAccessGrants.portalIdentityId, portalIdentityId),
            isNull(portalAccessGrants.deletedAt),
            isNull(portalAccessGrants.revokedAt),
            notExpired(portalAccessGrants.expiresAt, now),
          ),
        )
        .orderBy(asc(portalAccessGrants.createdAt))
        .limit(200)
    },

    /* ------------------------------ sessions ----------------------------- */

    async createMagicLink(
      db: Database,
      input: CreatePortalSessionInput,
    ): Promise<PortalSessionRow> {
      const rows = await db
        .insert(portalSessions)
        .values({
          workspaceId: input.workspaceId,
          portalIdentityId: input.portalIdentityId,
          kind: "magic_link",
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          userAgent: input.userAgent ?? null,
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("portal.createMagicLink: insert returned no row")
      return row
    },

    /**
     * Single use, enforced by the database.
     *
     * The guard lives in the UPDATE's WHERE clause, so two concurrent
     * exchanges of the same link race on the row lock and exactly one of them
     * gets a row back. A service-level "read, check, write" would let both
     * through under concurrency.
     */
    async consumeMagicLink(
      db: Database,
      tokenHash: string,
      now = new Date(),
    ): Promise<PortalSessionRow | null> {
      const rows = await db
        .update(portalSessions)
        .set({ consumedAt: now, updatedAt: now })
        .where(
          and(
            eq(portalSessions.tokenHash, tokenHash),
            eq(portalSessions.kind, "magic_link"),
            isNull(portalSessions.consumedAt),
            isNull(portalSessions.revokedAt),
            isNull(portalSessions.deletedAt),
            gt(portalSessions.expiresAt, now),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async createSession(db: Database, input: CreatePortalSessionInput): Promise<PortalSessionRow> {
      const rows = await db
        .insert(portalSessions)
        .values({
          workspaceId: input.workspaceId,
          portalIdentityId: input.portalIdentityId,
          kind: "session",
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          userAgent: input.userAgent ?? null,
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("portal.createSession: insert returned no row")
      return row
    },

    /**
     * Resolve a live portal session by token hash. `kind = 'session'` matters:
     * an unexchanged magic-link hash must never work as a session cookie.
     */
    async findActiveSession(
      db: Database,
      tokenHash: string,
      now = new Date(),
    ): Promise<PortalSessionRow | null> {
      const rows = await db
        .select()
        .from(portalSessions)
        .where(
          and(
            eq(portalSessions.tokenHash, tokenHash),
            eq(portalSessions.kind, "session"),
            isNull(portalSessions.revokedAt),
            isNull(portalSessions.deletedAt),
            gt(portalSessions.expiresAt, now),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    async touchSession(db: Database, id: string, now = new Date()): Promise<void> {
      await db
        .update(portalSessions)
        .set({ lastUsedAt: now, updatedAt: now })
        .where(eq(portalSessions.id, id))
    },

    async revokeSession(db: Database, workspaceId: string, id: string, now = new Date()) {
      await db
        .update(portalSessions)
        .set({ revokedAt: now, updatedAt: now })
        .where(and(eq(portalSessions.id, id), eq(portalSessions.workspaceId, workspaceId)))
    },

    /* --------------------------- scoped reads ---------------------------- */

    async listInvoices(
      db: Database,
      scope: PortalReadScope,
      opts: PortalListOptions = {},
    ): Promise<PortalPage<PortalInvoiceListRow>> {
      const limit = pageLimit(opts.limit)
      const order = opts.order === "asc" ? "asc" : "desc"
      const conditions: SQL[] = [
        invoiceScope(scope),
        inArray(invoices.status, [...PORTAL_VISIBLE_INVOICE_STATUSES]),
      ]
      if (opts.status) conditions.push(eq(invoices.status, opts.status))
      const keyset = cursorCondition(
        invoices.createdAt,
        invoices.id,
        decodePortalCursor(opts.cursor),
        order,
      )
      if (keyset) conditions.push(keyset)

      const rows = await db
        .select({
          ...portalInvoiceColumns,
          totalCents: invoiceTotalCentsSql,
          paidCents: invoicePaidCentsSql,
        })
        .from(invoices)
        .where(and(...conditions))
        .orderBy(
          order === "asc" ? asc(invoices.createdAt) : desc(invoices.createdAt),
          order === "asc" ? asc(invoices.id) : desc(invoices.id),
        )
        .limit(limit + 1)

      const hasMore = rows.length > limit
      const data = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
        ...row,
        totalCents: toCents(row.totalCents),
        paidCents: toCents(row.paidCents),
      }))
      return { data, pagination: { nextCursor: nextCursorOf(data, hasMore), limit } }
    },

    async findInvoice(
      db: Database,
      scope: PortalReadScope,
      id: string,
    ): Promise<PortalInvoiceListRow | null> {
      const rows = await db
        .select({
          ...portalInvoiceColumns,
          totalCents: invoiceTotalCentsSql,
          paidCents: invoicePaidCentsSql,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.id, id),
            invoiceScope(scope),
            inArray(invoices.status, [...PORTAL_VISIBLE_INVOICE_STATUSES]),
          ),
        )
        .limit(1)
      const row = rows[0]
      if (!row) return null
      return { ...row, totalCents: toCents(row.totalCents), paidCents: toCents(row.paidCents) }
    },

    /**
     * Line items for one invoice, re-scoped through the parent JOIN. Guessing
     * an invoice id cannot leak somebody else's prices.
     */
    async listInvoiceLineItems(
      db: Database,
      scope: PortalReadScope,
      invoiceId: string,
    ): Promise<PortalLineItemRow[]> {
      return await db
        .select(portalLineItemColumns)
        .from(invoiceLineItems)
        .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
        .where(
          and(
            eq(invoiceLineItems.invoiceId, invoiceId),
            isNull(invoiceLineItems.deletedAt),
            invoiceScope(scope),
            inArray(invoices.status, [...PORTAL_VISIBLE_INVOICE_STATUSES]),
          ),
        )
        .orderBy(asc(invoiceLineItems.position))
        .limit(500)
    },

    /**
     * Total paid, as one aggregate. Payment ROWS are not exposed: `reference`
     * and `notes` on a payment are internal bookkeeping.
     */
    async sumInvoicePayments(
      db: Database,
      scope: PortalReadScope,
      invoiceId: string,
    ): Promise<number> {
      const rows = await db
        .select({ total: sum(payments.amountCents) })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .where(
          and(
            eq(payments.invoiceId, invoiceId),
            isNull(payments.deletedAt),
            invoiceScope(scope),
            inArray(invoices.status, [...PORTAL_VISIBLE_INVOICE_STATUSES]),
          ),
        )
      const total = rows[0]?.total
      if (total === null || total === undefined) return 0
      const parsed = typeof total === "number" ? total : Number.parseInt(total, 10)
      return Number.isFinite(parsed) ? parsed : 0
    },

    async listQuotes(
      db: Database,
      scope: PortalReadScope,
      opts: PortalListOptions = {},
    ): Promise<PortalPage<PortalQuoteListRow>> {
      const limit = pageLimit(opts.limit)
      const order = opts.order === "asc" ? "asc" : "desc"
      const conditions: SQL[] = [
        quoteScope(scope),
        inArray(quotes.status, [...PORTAL_VISIBLE_QUOTE_STATUSES]),
      ]
      if (opts.status) conditions.push(eq(quotes.status, opts.status))
      const keyset = cursorCondition(
        quotes.createdAt,
        quotes.id,
        decodePortalCursor(opts.cursor),
        order,
      )
      if (keyset) conditions.push(keyset)

      const rows = await db
        .select({ ...portalQuoteColumns, subtotalCents: quoteSubtotalCentsSql })
        .from(quotes)
        .where(and(...conditions))
        .orderBy(
          order === "asc" ? asc(quotes.createdAt) : desc(quotes.createdAt),
          order === "asc" ? asc(quotes.id) : desc(quotes.id),
        )
        .limit(limit + 1)

      const hasMore = rows.length > limit
      const data = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
        ...row,
        subtotalCents: toCents(row.subtotalCents),
      }))
      return { data, pagination: { nextCursor: nextCursorOf(data, hasMore), limit } }
    },

    async findQuote(
      db: Database,
      scope: PortalReadScope,
      id: string,
    ): Promise<PortalQuoteListRow | null> {
      const rows = await db
        .select({ ...portalQuoteColumns, subtotalCents: quoteSubtotalCentsSql })
        .from(quotes)
        .where(
          and(
            eq(quotes.id, id),
            quoteScope(scope),
            inArray(quotes.status, [...PORTAL_VISIBLE_QUOTE_STATUSES]),
          ),
        )
        .limit(1)
      const row = rows[0]
      if (!row) return null
      return { ...row, subtotalCents: toCents(row.subtotalCents) }
    },

    async listQuoteLineItems(
      db: Database,
      scope: PortalReadScope,
      quoteId: string,
    ): Promise<PortalLineItemRow[]> {
      return await db
        .select(portalQuoteLineItemColumns)
        .from(quoteLineItems)
        .innerJoin(quotes, eq(quotes.id, quoteLineItems.quoteId))
        .where(
          and(
            eq(quoteLineItems.quoteId, quoteId),
            isNull(quoteLineItems.deletedAt),
            quoteScope(scope),
            inArray(quotes.status, [...PORTAL_VISIBLE_QUOTE_STATUSES]),
          ),
        )
        .orderBy(asc(quoteLineItems.position))
        .limit(500)
    },
  }
}

export type PortalRepository = ReturnType<typeof createPortalRepository>
