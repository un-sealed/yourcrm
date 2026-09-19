import {
  and,
  desc,
  eq,
  ilike,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm"
import type { Database } from "../client"
import { memberships, users, workspaces } from "../schema/core"
import { workspaceInvites } from "../schema/settings"

/**
 * Workspace profile, member and invitation persistence (specs 40 + 41, P0).
 *
 * Three rules this file follows deliberately:
 *
 *  1. **The workspace profile is the `workspaces` row.** There is no
 *     `workspace_settings` table to keep in sync — `0320_settings.sql` added
 *     the missing columns (date format, branding) to the row that already
 *     held name/timezone/currency.
 *  2. **`memberships.role` stays the authoritative role.** Member management
 *     writes that column; it does not introduce a second role store. All the
 *     escalation rules that decide *whether* a write is allowed live in the
 *     domain layer (`@yourcrm/crm` settings/roles.ts), never here.
 *  3. **Invites store a hash.** `createInvite` takes an already-hashed token;
 *     this layer has no way to reconstruct the raw one, so it cannot leak it.
 *
 * Deactivation is `memberships.deleted_at` (soft delete, restorable), so a
 * deactivated member keeps their audit trail, teams and record ownership.
 */

export type SettingsListOptions = {
  limit?: number
  cursor?: string | null
}

export type SettingsPage<T> = {
  data: T[]
  pagination: { nextCursor: string | null; limit: number }
}

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 200

export function clampSettingsLimit(limit?: number): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
}

/**
 * Keyset cursor over `(created_at DESC, id DESC)` — the pair every list in
 * this module orders by. Encoded as `<iso>|<uuid>`: a page boundary that
 * cannot drop or repeat a row when two rows share a timestamp, which the
 * foundation's offset-free `base.list` cursor (an id with no WHERE clause)
 * does not give us.
 */
export function encodeSettingsCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}|${id}`
}

export type SettingsCursor = { createdAt: Date; id: string }

export function decodeSettingsCursor(cursor?: string | null): SettingsCursor | null {
  if (!cursor) return null
  const at = cursor.indexOf("|")
  if (at < 0) throw new Error("settings: cursor is not a valid cursor token")
  const createdAt = new Date(cursor.slice(0, at))
  const id = cursor.slice(at + 1)
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
    throw new Error("settings: cursor is not a valid cursor token")
  }
  return { createdAt, id }
}

/** `(created_at, id) < (cursor.created_at, cursor.id)` for DESC paging. */
export function settingsKeysetCondition(
  createdAtColumn: AnyColumn,
  idColumn: AnyColumn,
  cursor: SettingsCursor,
): SQL {
  return sql`(${createdAtColumn}, ${idColumn}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
}

export function paginateSettingsRows<T extends { createdAt: string; id: string }>(
  rows: T[],
  limit: number,
): SettingsPage<T> {
  const hasMore = rows.length > limit
  const data = hasMore ? rows.slice(0, limit) : rows
  const last = data[data.length - 1]
  return {
    data,
    pagination: {
      nextCursor: hasMore && last ? encodeSettingsCursor(new Date(last.createdAt), last.id) : null,
      limit,
    },
  }
}

export type WorkspaceProfileRow = {
  id: string
  name: string
  slug: string
  timezone: string
  currency: string
  dateFormat: string
  logoUrl: string | null
  brandColor: string | null
  supportEmail: string | null
  updatedAt: string
}

export type WorkspaceProfilePatch = {
  name?: string
  timezone?: string
  currency?: string
  dateFormat?: string
  logoUrl?: string | null
  brandColor?: string | null
  supportEmail?: string | null
}

export type WorkspaceMemberRow = {
  membershipId: string
  userId: string
  email: string
  name: string | null
  role: string
  active: boolean
  joinedAt: string
  createdAt: string
  id: string
  lastLoginAt: string | null
}

export type WorkspaceMemberFilter = SettingsListOptions & {
  query?: string
  role?: string
  status?: "active" | "inactive"
}

export type WorkspaceInviteRow = {
  id: string
  workspaceId: string
  email: string
  role: string
  expiresAt: string
  acceptedAt: string | null
  revokedAt: string | null
  invitedBy: string | null
  createdAt: string
}

export type CreateWorkspaceInviteInput = {
  email: string
  role: string
  /** Already hashed by the caller — the raw token never reaches this layer. */
  tokenHash: string
  expiresAt: Date
  invitedBy?: string | null
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : value
}

function isoRequired(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

export function normalizeInviteEmail(email: string): string {
  const trimmed = email.trim().toLowerCase()
  if (trimmed.length === 0) throw new Error("settings: invite email must not be empty")
  if (trimmed.length > 320) throw new Error("settings: invite email must be at most 320 chars")
  return trimmed
}

export function createWorkspaceSettingsRepository() {
  return {
    // --- workspace profile ---------------------------------------------------

    async getWorkspace(db: Database, workspaceId: string): Promise<WorkspaceProfileRow | null> {
      const rows = await db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
        .limit(1)
      const row = rows[0]
      if (!row) return null
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        timezone: row.timezone,
        currency: row.currency,
        dateFormat: row.dateFormat,
        logoUrl: row.logoUrl,
        brandColor: row.brandColor,
        supportEmail: row.supportEmail,
        updatedAt: isoRequired(row.updatedAt),
      }
    },

    async updateWorkspace(
      db: Database,
      workspaceId: string,
      patch: WorkspaceProfilePatch,
      actorId?: string,
    ): Promise<WorkspaceProfileRow | null> {
      const values: Record<string, unknown> = { updatedAt: new Date() }
      if (patch.name !== undefined) values.name = patch.name
      if (patch.timezone !== undefined) values.timezone = patch.timezone
      if (patch.currency !== undefined) values.currency = patch.currency
      if (patch.dateFormat !== undefined) values.dateFormat = patch.dateFormat
      if (patch.logoUrl !== undefined) values.logoUrl = patch.logoUrl
      if (patch.brandColor !== undefined) values.brandColor = patch.brandColor
      if (patch.supportEmail !== undefined) values.supportEmail = patch.supportEmail
      if (actorId !== undefined) values.updatedBy = actorId
      await db
        .update(workspaces)
        .set(values)
        .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
      return this.getWorkspace(db, workspaceId)
    },

    // --- members -------------------------------------------------------------

    async listMembers(
      db: Database,
      workspaceId: string,
      opts: WorkspaceMemberFilter = {},
    ): Promise<SettingsPage<WorkspaceMemberRow>> {
      const limit = clampSettingsLimit(opts.limit)
      const conditions: SQL[] = [eq(memberships.workspaceId, workspaceId)]
      if (opts.status === "active") conditions.push(isNull(memberships.deletedAt))
      if (opts.status === "inactive") conditions.push(isNotNull(memberships.deletedAt))
      if (opts.role) conditions.push(eq(memberships.role, opts.role))
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const match = or(ilike(users.email, q), ilike(users.name, q))
        if (match) conditions.push(match)
      }
      const cursor = decodeSettingsCursor(opts.cursor)
      if (cursor) {
        conditions.push(settingsKeysetCondition(memberships.createdAt, memberships.id, cursor))
      }
      const rows = await db
        .select({
          membershipId: memberships.id,
          userId: users.id,
          email: users.email,
          name: users.name,
          role: memberships.role,
          deletedAt: memberships.deletedAt,
          createdAt: memberships.createdAt,
          lastLoginAt: users.lastLoginAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(...conditions))
        .orderBy(desc(memberships.createdAt), desc(memberships.id))
        .limit(limit + 1)
      return paginateSettingsRows(rows.map(toMemberRow), limit)
    },

    async findMember(
      db: Database,
      workspaceId: string,
      membershipId: string,
    ): Promise<WorkspaceMemberRow | null> {
      const rows = await db
        .select({
          membershipId: memberships.id,
          userId: users.id,
          email: users.email,
          name: users.name,
          role: memberships.role,
          deletedAt: memberships.deletedAt,
          createdAt: memberships.createdAt,
          lastLoginAt: users.lastLoginAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.id, membershipId), eq(memberships.workspaceId, workspaceId)))
        .limit(1)
      const row = rows[0]
      return row ? toMemberRow(row) : null
    },

    /** Live owners only — the "last owner" guard counts this, never a cache. */
    async countActiveOwners(db: Database, workspaceId: string): Promise<number> {
      const rows = await db
        .select({ value: sql<number>`count(*)` })
        .from(memberships)
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            eq(memberships.role, "owner"),
            isNull(memberships.deletedAt),
          ),
        )
      return Number(rows[0]?.value ?? 0)
    },

    async updateMemberRole(
      db: Database,
      workspaceId: string,
      membershipId: string,
      role: string,
      actorId?: string,
    ): Promise<WorkspaceMemberRow | null> {
      await db
        .update(memberships)
        .set({
          role,
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(
          and(
            eq(memberships.id, membershipId),
            eq(memberships.workspaceId, workspaceId),
            isNull(memberships.deletedAt),
          ),
        )
      return this.findMember(db, workspaceId, membershipId)
    },

    /** Deactivate/reactivate = soft delete/restore of the membership row. */
    async setMemberActive(
      db: Database,
      workspaceId: string,
      membershipId: string,
      active: boolean,
      actorId?: string,
    ): Promise<WorkspaceMemberRow | null> {
      await db
        .update(memberships)
        .set({
          deletedAt: active ? null : new Date(),
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(and(eq(memberships.id, membershipId), eq(memberships.workspaceId, workspaceId)))
      return this.findMember(db, workspaceId, membershipId)
    },

    // --- invitations ---------------------------------------------------------

    async listInvites(
      db: Database,
      workspaceId: string,
      opts: SettingsListOptions & { state?: "pending" | "all" } = {},
    ): Promise<SettingsPage<WorkspaceInviteRow>> {
      const limit = clampSettingsLimit(opts.limit)
      const conditions: SQL[] = [
        eq(workspaceInvites.workspaceId, workspaceId),
        isNull(workspaceInvites.deletedAt),
      ]
      if (opts.state !== "all") {
        conditions.push(isNull(workspaceInvites.acceptedAt), isNull(workspaceInvites.revokedAt))
      }
      const cursor = decodeSettingsCursor(opts.cursor)
      if (cursor) {
        conditions.push(
          settingsKeysetCondition(workspaceInvites.createdAt, workspaceInvites.id, cursor),
        )
      }
      const rows = await db
        .select()
        .from(workspaceInvites)
        .where(and(...conditions))
        .orderBy(desc(workspaceInvites.createdAt), desc(workspaceInvites.id))
        .limit(limit + 1)
      return paginateSettingsRows(rows.map(toInviteRow), limit)
    },

    async findInvite(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<WorkspaceInviteRow | null> {
      const rows = await db
        .select()
        .from(workspaceInvites)
        .where(
          and(
            eq(workspaceInvites.id, id),
            eq(workspaceInvites.workspaceId, workspaceId),
            isNull(workspaceInvites.deletedAt),
          ),
        )
        .limit(1)
      const row = rows[0]
      return row ? toInviteRow(row) : null
    },

    async findPendingInviteByEmail(
      db: Database,
      workspaceId: string,
      email: string,
    ): Promise<WorkspaceInviteRow | null> {
      const rows = await db
        .select()
        .from(workspaceInvites)
        .where(
          and(
            eq(workspaceInvites.workspaceId, workspaceId),
            eq(workspaceInvites.email, normalizeInviteEmail(email)),
            isNull(workspaceInvites.acceptedAt),
            isNull(workspaceInvites.revokedAt),
            isNull(workspaceInvites.deletedAt),
          ),
        )
        .limit(1)
      const row = rows[0]
      return row ? toInviteRow(row) : null
    },

    /**
     * Look an invite up by the hash of a presented token. The seam the
     * signup flow will use; it never receives the stored hash back.
     */
    async findInviteByTokenHash(
      db: Database,
      tokenHash: string,
    ): Promise<WorkspaceInviteRow | null> {
      const rows = await db
        .select()
        .from(workspaceInvites)
        .where(and(eq(workspaceInvites.tokenHash, tokenHash), isNull(workspaceInvites.deletedAt)))
        .limit(1)
      const row = rows[0]
      return row ? toInviteRow(row) : null
    },

    async createInvite(
      db: Database,
      workspaceId: string,
      input: CreateWorkspaceInviteInput,
      actorId?: string,
    ): Promise<WorkspaceInviteRow> {
      const rows = await db
        .insert(workspaceInvites)
        .values({
          workspaceId,
          email: normalizeInviteEmail(input.email),
          role: input.role,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          invitedBy: input.invitedBy ?? actorId ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("settings.createInvite: insert returned no rows")
      return toInviteRow(row)
    },

    /** Resend: rotate the hash and the expiry so the old link dies at once. */
    async rotateInviteToken(
      db: Database,
      workspaceId: string,
      id: string,
      tokenHash: string,
      expiresAt: Date,
      actorId?: string,
    ): Promise<WorkspaceInviteRow | null> {
      const rows = await db
        .update(workspaceInvites)
        .set({
          tokenHash,
          expiresAt,
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(
          and(
            eq(workspaceInvites.id, id),
            eq(workspaceInvites.workspaceId, workspaceId),
            isNull(workspaceInvites.acceptedAt),
            isNull(workspaceInvites.revokedAt),
            isNull(workspaceInvites.deletedAt),
          ),
        )
        .returning()
      const row = rows[0]
      return row ? toInviteRow(row) : null
    },

    async revokeInvite(
      db: Database,
      workspaceId: string,
      id: string,
      actorId?: string,
    ): Promise<WorkspaceInviteRow | null> {
      const rows = await db
        .update(workspaceInvites)
        .set({
          revokedAt: new Date(),
          revokedBy: actorId ?? null,
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(
          and(
            eq(workspaceInvites.id, id),
            eq(workspaceInvites.workspaceId, workspaceId),
            isNull(workspaceInvites.acceptedAt),
            isNull(workspaceInvites.revokedAt),
            isNull(workspaceInvites.deletedAt),
          ),
        )
        .returning()
      const row = rows[0]
      return row ? toInviteRow(row) : null
    },

    /** Housekeeping seam: expired invites are dead links, not credentials. */
    async expiredInviteCount(db: Database, workspaceId: string, now: Date): Promise<number> {
      const rows = await db
        .select({ value: sql<number>`count(*)` })
        .from(workspaceInvites)
        .where(
          and(
            eq(workspaceInvites.workspaceId, workspaceId),
            isNull(workspaceInvites.acceptedAt),
            isNull(workspaceInvites.revokedAt),
            isNull(workspaceInvites.deletedAt),
            lt(workspaceInvites.expiresAt, now),
          ),
        )
      return Number(rows[0]?.value ?? 0)
    },
  }
}

type RawMemberRow = {
  membershipId: string
  userId: string
  email: string
  name: string | null
  role: string
  deletedAt: Date | string | null
  createdAt: Date | string
  lastLoginAt: Date | string | null
}

function toMemberRow(row: RawMemberRow): WorkspaceMemberRow {
  const createdAt = isoRequired(row.createdAt)
  return {
    membershipId: row.membershipId,
    // `id` mirrors `membershipId` so the shared cursor helper can page this
    // projection like every other list in the module.
    id: row.membershipId,
    userId: row.userId,
    email: row.email,
    name: row.name,
    role: row.role,
    active: row.deletedAt === null,
    joinedAt: createdAt,
    createdAt,
    lastLoginAt: iso(row.lastLoginAt),
  }
}

type RawInviteRow = {
  id: string
  workspaceId: string
  email: string
  role: string
  expiresAt: Date | string
  acceptedAt: Date | string | null
  revokedAt: Date | string | null
  invitedBy: string | null
  createdAt: Date | string
}

/** Projection WITHOUT `tokenHash`: the secret never leaves this module. */
function toInviteRow(row: RawInviteRow): WorkspaceInviteRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    email: row.email,
    role: row.role,
    expiresAt: isoRequired(row.expiresAt),
    acceptedAt: iso(row.acceptedAt),
    revokedAt: iso(row.revokedAt),
    invitedBy: row.invitedBy,
    createdAt: isoRequired(row.createdAt),
  }
}

export type WorkspaceSettingsRepository = ReturnType<typeof createWorkspaceSettingsRepository>
