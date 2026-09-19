import { sql } from "drizzle-orm"
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns } from "./base"
import { users, workspaces } from "./core"

/**
 * Settings, security & compliance tables (specs 40 + 41, P0).
 * Migration `0320_settings.sql`.
 *
 * The workspace *profile* is not here: it lives on the `workspaces` row
 * itself (`schema/core.ts`), because a second table holding a workspace's
 * name/timezone/currency/branding would be a second source of truth for one
 * object. This file owns only what has nowhere else to live:
 *
 *   workspaceTeams       — grouping for ownership/visibility
 *   workspaceTeamMembers — membership <-> team edge
 *   workspaceInvites     — invitation tokens (hash + expiry)
 *   dataRequests         — GDPR/DPDP export + deletion requests
 *
 * There is deliberately no roles table: `memberships.role` plus the role-rank
 * policy in `@yourcrm/permissions` is the role model, and this module
 * configures it rather than replacing it.
 *
 * Export names are prefixed (`workspaceTeams`, not `teams`) because one
 * generated `export *` barrel covers every module's schema.
 */

/** Team position. Carries NO permission rank — `memberships.role` does. */
export const WORKSPACE_TEAM_ROLES = ["member", "lead"] as const

export type WorkspaceTeamRole = (typeof WORKSPACE_TEAM_ROLES)[number]

export function isWorkspaceTeamRole(value: unknown): value is WorkspaceTeamRole {
  return typeof value === "string" && (WORKSPACE_TEAM_ROLES as readonly string[]).includes(value)
}

/** Workspace access roles, mirroring `memberships.role` and the role-rank policy. */
export const WORKSPACE_MEMBER_ROLES = ["owner", "admin", "member", "viewer"] as const

export type WorkspaceMemberRole = (typeof WORKSPACE_MEMBER_ROLES)[number]

export function isWorkspaceMemberRole(value: unknown): value is WorkspaceMemberRole {
  return typeof value === "string" && (WORKSPACE_MEMBER_ROLES as readonly string[]).includes(value)
}

export const DATA_REQUEST_KINDS = ["export", "deletion"] as const

export type DataRequestKind = (typeof DATA_REQUEST_KINDS)[number]

export function isDataRequestKind(value: unknown): value is DataRequestKind {
  return typeof value === "string" && (DATA_REQUEST_KINDS as readonly string[]).includes(value)
}

export const DATA_REQUEST_STATUSES = ["pending", "fulfilled", "soft_deleted", "rejected"] as const

export type DataRequestStatus = (typeof DATA_REQUEST_STATUSES)[number]

/** A team inside a workspace. Slug is unique among live teams. */
export const workspaceTeams = pgTable(
  "teams",
  {
    ...baseColumns,
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 255 }).notNull(),
    description: text("description"),
  },
  (t) => [
    index("teams_workspace_idx").on(t.workspaceId),
    // Partial: a soft-deleted team releases its slug for reuse.
    uniqueIndex("teams_workspace_slug_uidx")
      .on(t.workspaceId, t.slug)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
)

export type WorkspaceTeamRow = typeof workspaceTeams.$inferSelect
export type NewWorkspaceTeamRow = typeof workspaceTeams.$inferInsert

/**
 * Membership <-> team edge. `membershipId` is a plain uuid with an index and
 * NO foreign key: `memberships` belongs to the auth foundation (same rule as
 * every `owner_id` in this schema).
 */
export const workspaceTeamMembers = pgTable(
  "team_members",
  {
    ...baseColumns,
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => workspaceTeams.id, { onDelete: "cascade" }),
    /** `memberships.id` — plain uuid, no FK (see above). */
    membershipId: uuid("membership_id").notNull(),
    teamRole: varchar("team_role", { length: 16 }).notNull().default("member"),
  },
  (t) => [
    index("team_members_workspace_idx").on(t.workspaceId),
    index("team_members_membership_idx").on(t.membershipId),
    uniqueIndex("team_members_team_membership_uidx")
      .on(t.teamId, t.membershipId)
      .where(sql`${t.deletedAt} IS NULL`),
    check("team_members_team_role_chk", sql`${t.teamRole} IN ('member', 'lead')`),
  ],
)

export type WorkspaceTeamMemberRow = typeof workspaceTeamMembers.$inferSelect
export type NewWorkspaceTeamMemberRow = typeof workspaceTeamMembers.$inferInsert

/**
 * Invitation token. An invite is a bearer credential, not a password:
 * only the SHA-256 hash of a 32-byte CSPRNG token is stored, it expires, and
 * revoking or resending replaces the hash. The raw token exists once, in the
 * creation response.
 */
export const workspaceInvites = pgTable(
  "workspace_invites",
  {
    ...baseColumns,
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 320 }).notNull(),
    role: varchar("role", { length: 32 }).notNull().default("member"),
    /** SHA-256 hex of the raw token — never the token itself. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id, { onDelete: "set null" }),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("workspace_invites_workspace_idx").on(t.workspaceId),
    uniqueIndex("workspace_invites_token_uidx").on(t.tokenHash),
    check("workspace_invites_role_chk", sql`${t.role} IN ('owner', 'admin', 'member', 'viewer')`),
  ],
)

export type WorkspaceInviteRow = typeof workspaceInvites.$inferSelect
export type NewWorkspaceInviteRow = typeof workspaceInvites.$inferInsert

/**
 * GDPR/DPDP request over one data subject.
 *
 * Holds no subject data on purpose: an export is assembled live from the
 * owning module's repository when it is downloaded, so answering a privacy
 * request never creates a second copy of the personal data. `subjectId` is a
 * plain uuid — the people module owns that table.
 */
export const dataRequests = pgTable(
  "data_requests",
  {
    ...baseColumns,
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 16 }).notNull(),
    subjectType: varchar("subject_type", { length: 32 }).notNull(),
    /** `people.id` — plain uuid, no FK (another module owns it). */
    subjectId: uuid("subject_id").notNull(),
    status: varchar("status", { length: 24 }).notNull().default("pending"),
    reason: text("reason"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("data_requests_workspace_idx").on(t.workspaceId),
    index("data_requests_subject_idx").on(t.workspaceId, t.subjectType, t.subjectId),
    index("data_requests_status_idx").on(t.workspaceId, t.status),
    check("data_requests_kind_chk", sql`${t.kind} IN ('export', 'deletion')`),
    check("data_requests_subject_type_chk", sql`${t.subjectType} IN ('person')`),
    check(
      "data_requests_status_chk",
      sql`${t.status} IN ('pending', 'fulfilled', 'soft_deleted', 'rejected')`,
    ),
  ],
)

export type DataRequestRow = typeof dataRequests.$inferSelect
export type NewDataRequestRow = typeof dataRequests.$inferInsert
