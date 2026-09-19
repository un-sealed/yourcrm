import { isNull, sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, workspaceColumn } from "./base"

/**
 * Customer portal (spec 45-customer-portal, P0). Migration `0330_customer_portal.sql`.
 *
 * READ THIS BEFORE TOUCHING ANY OF THE THREE TABLES.
 * --------------------------------------------------
 * Every other module in this schema is read by a *workspace member* whose
 * role is checked by `@yourcrm/permissions`. These three tables exist so the
 * CRM can be read by somebody who is not a member and has no role at all — a
 * customer. That means:
 *
 *  - a `portal_identities` row is NOT a `users` row and NOT a `memberships`
 *    row. It cannot be turned into one, and a portal session can never
 *    satisfy `requirePermission()`;
 *  - `portal_access_grants` is the complete, explicit allow-list for one
 *    identity. Absence of a grant is denial. There is no fallback, no
 *    "owner sees everything", no role rank;
 *  - `portal_sessions` is a *separate token space* from `sessions`
 *    (0002_auth.sql). Different table, different cookie name, different
 *    resolver. A member token presented to a portal route resolves to
 *    nothing, and vice versa, because each resolver only ever looks in its
 *    own table.
 *
 * Cross-module columns (`person_id`, `scope_id`) are plain uuids with indexes
 * and no foreign keys — people and companies belong to other modules, same
 * rule as `people.company_id` (0010) and `search_index.record_id` (0110). The
 * two FKs that do exist point at `portal_identities` in this same file and
 * cascade, so revoking an identity by deletion takes its grants and its live
 * sessions with it.
 */

/** Identity lifecycle. `revoked` is terminal for P0 (spec 45 §3 access revocation). */
export const PORTAL_IDENTITY_STATUSES = ["active", "revoked"] as const

export type PortalIdentityStatus = (typeof PORTAL_IDENTITY_STATUSES)[number]

export function isPortalIdentityStatus(value: unknown): value is PortalIdentityStatus {
  return (
    typeof value === "string" && (PORTAL_IDENTITY_STATUSES as readonly string[]).includes(value)
  )
}

/** What a grant's `scope_id` points at. */
export const PORTAL_GRANT_SCOPE_TYPES = ["person", "company"] as const

export type PortalGrantScopeType = (typeof PORTAL_GRANT_SCOPE_TYPES)[number]

export function isPortalGrantScopeType(value: unknown): value is PortalGrantScopeType {
  return (
    typeof value === "string" && (PORTAL_GRANT_SCOPE_TYPES as readonly string[]).includes(value)
  )
}

/**
 * Both halves of magic-link auth live in one table: a `magic_link` row is a
 * session that has not started yet. One uniqueness domain for `token_hash`,
 * one expiry sweep, one revocation path.
 */
export const PORTAL_SESSION_KINDS = ["magic_link", "session"] as const

export type PortalSessionKind = (typeof PORTAL_SESSION_KINDS)[number]

export function isPortalSessionKind(value: unknown): value is PortalSessionKind {
  return typeof value === "string" && (PORTAL_SESSION_KINDS as readonly string[]).includes(value)
}

/**
 * A person who has been granted portal access. `email` is stored trimmed and
 * lowercased by the repository so the unique index and the login lookup agree.
 */
export const portalIdentities = pgTable(
  "portal_identities",
  {
    ...baseColumns,
    ...workspaceColumn,
    /** `people.id`. Plain uuid, no FK — see header. */
    personId: uuid("person_id").notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    displayName: varchar("display_name", { length: 255 }),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    /** Access expiry (spec 45 §3). Null means "until revoked". */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => [
    index("portal_identities_workspace_idx").on(t.workspaceId),
    uniqueIndex("portal_identities_workspace_email_uidx")
      .on(t.workspaceId, t.email)
      .where(isNull(t.deletedAt)),
    // Login starts with an email and no tenant context, so this index is
    // deliberately not workspace-first.
    index("portal_identities_email_idx").on(t.email),
    index("portal_identities_person_idx").on(t.personId),
    check("portal_identities_status_chk", sql`${t.status} IN ('active', 'revoked')`),
  ],
)

export type PortalIdentityRow = typeof portalIdentities.$inferSelect
export type NewPortalIdentityRow = typeof portalIdentities.$inferInsert

/**
 * One entry in an identity's allow-list. The portal's entire read surface is
 * `(scope_type, scope_id)` pairs from live rows here, filtered by the
 * per-resource flag. No row, no access.
 */
export const portalAccessGrants = pgTable(
  "portal_access_grants",
  {
    ...baseColumns,
    ...workspaceColumn,
    portalIdentityId: uuid("portal_identity_id")
      .notNull()
      .references(() => portalIdentities.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", { length: 16 }).notNull(),
    /** `people.id` or `companies.id`, per `scope_type`. Plain uuid, no FK. */
    scopeId: uuid("scope_id").notNull(),
    canViewTickets: boolean("can_view_tickets").notNull().default(false),
    canViewInvoices: boolean("can_view_invoices").notNull().default(false),
    canViewQuotes: boolean("can_view_quotes").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("portal_access_grants_workspace_idx").on(t.workspaceId),
    index("portal_access_grants_identity_idx").on(t.workspaceId, t.portalIdentityId),
    index("portal_access_grants_scope_idx").on(t.workspaceId, t.scopeType, t.scopeId),
    uniqueIndex("portal_access_grants_identity_scope_uidx")
      .on(t.workspaceId, t.portalIdentityId, t.scopeType, t.scopeId)
      .where(isNull(t.deletedAt)),
    check("portal_access_grants_scope_type_chk", sql`${t.scopeType} IN ('person', 'company')`),
  ],
)

export type PortalAccessGrantRow = typeof portalAccessGrants.$inferSelect
export type NewPortalAccessGrantRow = typeof portalAccessGrants.$inferInsert

/**
 * Magic-link challenges (`kind = 'magic_link'`, single use) and live portal
 * sessions (`kind = 'session'`). Only the SHA-256 hash of the token is stored.
 */
export const portalSessions = pgTable(
  "portal_sessions",
  {
    ...baseColumns,
    ...workspaceColumn,
    portalIdentityId: uuid("portal_identity_id")
      .notNull()
      .references(() => portalIdentities.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 16 }).notNull(),
    /** SHA-256 hex of the raw token. The raw token is never stored or logged. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Written once by the atomic single-use UPDATE in the repository. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    userAgent: varchar("user_agent", { length: 255 }),
  },
  (t) => [
    // Global, not per-workspace: a token must resolve to one row before any
    // tenant is known.
    uniqueIndex("portal_sessions_token_hash_uidx").on(t.tokenHash),
    index("portal_sessions_identity_idx").on(t.workspaceId, t.portalIdentityId),
    index("portal_sessions_expires_idx").on(t.expiresAt),
    check("portal_sessions_kind_chk", sql`${t.kind} IN ('magic_link', 'session')`),
    check("portal_sessions_consumed_chk", sql`${t.consumedAt} IS NULL OR ${t.kind} = 'magic_link'`),
  ],
)

export type PortalSessionRow = typeof portalSessions.$inferSelect
export type NewPortalSessionRow = typeof portalSessions.$inferInsert
