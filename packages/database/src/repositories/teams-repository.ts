import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import { memberships, users } from "../schema/core"
import { workspaceTeamMembers, workspaceTeams } from "../schema/settings"
import {
  clampSettingsLimit,
  decodeSettingsCursor,
  paginateSettingsRows,
  settingsKeysetCondition,
  type SettingsListOptions,
  type SettingsPage,
} from "./settings-repository"

/**
 * Teams persistence (spec 41, P0).
 *
 * A team is a *grouping*, not a role: joining one grants no permission rank,
 * and `team_members.team_role` ("member" | "lead") is a position inside the
 * team. `memberships.role` remains the only thing `@yourcrm/permissions`
 * reads. That is why `addMember` verifies the membership belongs to this
 * workspace but never touches its role.
 *
 * `membership_id` is a plain uuid (no FK) because `memberships` belongs to
 * the auth foundation — see `0320_settings.sql`.
 */

export type WorkspaceTeamRecordRow = {
  id: string
  workspaceId: string
  name: string
  slug: string
  description: string | null
  memberCount: number
  createdAt: string
  updatedAt: string
}

export type WorkspaceTeamMemberRecordRow = {
  id: string
  teamId: string
  membershipId: string
  teamRole: string
  userId: string | null
  email: string | null
  name: string | null
  workspaceRole: string | null
  createdAt: string
}

export type CreateWorkspaceTeamInput = {
  name: string
  slug: string
  description?: string | null
}

export type UpdateWorkspaceTeamInput = {
  name?: string
  slug?: string
  description?: string | null
}

function isoRequired(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

export class WorkspaceTeamSlugTakenError extends Error {
  readonly code = "CONFLICT"
  constructor(slug: string) {
    super(`team slug '${slug}' is already used in this workspace`)
    this.name = "WorkspaceTeamSlugTakenError"
  }
}

/** Lower-kebab slug derived from a team name (or validated when supplied). */
export function normalizeTeamSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (slug.length === 0) throw new Error("teams: slug must contain a letter or digit")
  if (slug.length > 255) throw new Error("teams: slug must be at most 255 characters")
  return slug
}

export function createWorkspaceTeamRepository() {
  async function memberCounts(
    db: Database,
    workspaceId: string,
    teamIds: string[],
  ): Promise<Map<string, number>> {
    if (teamIds.length === 0) return new Map()
    const rows = await db
      .select({ teamId: workspaceTeamMembers.teamId, value: sql<number>`count(*)` })
      .from(workspaceTeamMembers)
      .where(
        and(
          eq(workspaceTeamMembers.workspaceId, workspaceId),
          isNull(workspaceTeamMembers.deletedAt),
          inArray(workspaceTeamMembers.teamId, teamIds),
        ),
      )
      .groupBy(workspaceTeamMembers.teamId)
    return new Map(rows.map((row) => [row.teamId, Number(row.value)]))
  }

  return {
    async list(
      db: Database,
      workspaceId: string,
      opts: SettingsListOptions & { query?: string } = {},
    ): Promise<SettingsPage<WorkspaceTeamRecordRow>> {
      const limit = clampSettingsLimit(opts.limit)
      const conditions: SQL[] = [
        eq(workspaceTeams.workspaceId, workspaceId),
        isNull(workspaceTeams.deletedAt),
      ]
      if (opts.query) {
        conditions.push(sql`${workspaceTeams.name} ILIKE ${`%${opts.query.trim()}%`}`)
      }
      const cursor = decodeSettingsCursor(opts.cursor)
      if (cursor) {
        conditions.push(
          settingsKeysetCondition(workspaceTeams.createdAt, workspaceTeams.id, cursor),
        )
      }
      const rows = await db
        .select()
        .from(workspaceTeams)
        .where(and(...conditions))
        .orderBy(desc(workspaceTeams.createdAt), desc(workspaceTeams.id))
        .limit(limit + 1)
      const counts = await memberCounts(
        db,
        workspaceId,
        rows.map((row) => row.id),
      )
      return paginateSettingsRows(
        rows.map((row) => toTeamRow(row, counts.get(row.id) ?? 0)),
        limit,
      )
    },

    async findById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<WorkspaceTeamRecordRow | null> {
      const rows = await db
        .select()
        .from(workspaceTeams)
        .where(
          and(
            eq(workspaceTeams.id, id),
            eq(workspaceTeams.workspaceId, workspaceId),
            isNull(workspaceTeams.deletedAt),
          ),
        )
        .limit(1)
      const row = rows[0]
      if (!row) return null
      const counts = await memberCounts(db, workspaceId, [row.id])
      return toTeamRow(row, counts.get(row.id) ?? 0)
    },

    async findBySlug(
      db: Database,
      workspaceId: string,
      slug: string,
    ): Promise<WorkspaceTeamRecordRow | null> {
      const rows = await db
        .select()
        .from(workspaceTeams)
        .where(
          and(
            eq(workspaceTeams.slug, slug),
            eq(workspaceTeams.workspaceId, workspaceId),
            isNull(workspaceTeams.deletedAt),
          ),
        )
        .limit(1)
      const row = rows[0]
      return row ? toTeamRow(row, 0) : null
    },

    async create(
      db: Database,
      workspaceId: string,
      input: CreateWorkspaceTeamInput,
      actorId?: string,
    ): Promise<WorkspaceTeamRecordRow> {
      const slug = normalizeTeamSlug(input.slug)
      const existing = await this.findBySlug(db, workspaceId, slug)
      if (existing) throw new WorkspaceTeamSlugTakenError(slug)
      const rows = await db
        .insert(workspaceTeams)
        .values({
          workspaceId,
          name: input.name.trim(),
          slug,
          description: input.description ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("teams.create: insert returned no rows")
      return toTeamRow(row, 0)
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateWorkspaceTeamInput,
      actorId?: string,
    ): Promise<WorkspaceTeamRecordRow | null> {
      const values: Record<string, unknown> = { updatedAt: new Date() }
      if (input.name !== undefined) values.name = input.name.trim()
      if (input.slug !== undefined) {
        const slug = normalizeTeamSlug(input.slug)
        const existing = await this.findBySlug(db, workspaceId, slug)
        if (existing && existing.id !== id) throw new WorkspaceTeamSlugTakenError(slug)
        values.slug = slug
      }
      if (input.description !== undefined) values.description = input.description
      if (actorId !== undefined) values.updatedBy = actorId
      await db
        .update(workspaceTeams)
        .set(values)
        .where(
          and(
            eq(workspaceTeams.id, id),
            eq(workspaceTeams.workspaceId, workspaceId),
            isNull(workspaceTeams.deletedAt),
          ),
        )
      return this.findById(db, workspaceId, id)
    },

    /** Soft delete: the team row and its edges stay for the audit trail. */
    async softDelete(
      db: Database,
      workspaceId: string,
      id: string,
      actorId?: string,
    ): Promise<void> {
      const deletedAt = new Date()
      await db
        .update(workspaceTeams)
        .set({
          deletedAt,
          updatedAt: deletedAt,
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(and(eq(workspaceTeams.id, id), eq(workspaceTeams.workspaceId, workspaceId)))
      await db
        .update(workspaceTeamMembers)
        .set({ deletedAt, updatedAt: deletedAt })
        .where(
          and(
            eq(workspaceTeamMembers.teamId, id),
            eq(workspaceTeamMembers.workspaceId, workspaceId),
            isNull(workspaceTeamMembers.deletedAt),
          ),
        )
    },

    async listMembers(
      db: Database,
      workspaceId: string,
      teamId: string,
    ): Promise<WorkspaceTeamMemberRecordRow[]> {
      const rows = await db
        .select({
          id: workspaceTeamMembers.id,
          teamId: workspaceTeamMembers.teamId,
          membershipId: workspaceTeamMembers.membershipId,
          teamRole: workspaceTeamMembers.teamRole,
          createdAt: workspaceTeamMembers.createdAt,
          userId: users.id,
          email: users.email,
          name: users.name,
          workspaceRole: memberships.role,
        })
        .from(workspaceTeamMembers)
        .leftJoin(memberships, eq(memberships.id, workspaceTeamMembers.membershipId))
        .leftJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(workspaceTeamMembers.teamId, teamId),
            eq(workspaceTeamMembers.workspaceId, workspaceId),
            isNull(workspaceTeamMembers.deletedAt),
          ),
        )
        .orderBy(desc(workspaceTeamMembers.createdAt))
      return rows.map((row) => ({
        id: row.id,
        teamId: row.teamId,
        membershipId: row.membershipId,
        teamRole: row.teamRole,
        userId: row.userId,
        email: row.email,
        name: row.name,
        workspaceRole: row.workspaceRole,
        createdAt: isoRequired(row.createdAt),
      }))
    },

    /** True when the membership exists in this workspace (active or not). */
    async membershipExists(
      db: Database,
      workspaceId: string,
      membershipId: string,
    ): Promise<boolean> {
      const rows = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.id, membershipId), eq(memberships.workspaceId, workspaceId)))
        .limit(1)
      return rows.length > 0
    },

    async addMember(
      db: Database,
      workspaceId: string,
      teamId: string,
      membershipId: string,
      teamRole: string,
      actorId?: string,
    ): Promise<WorkspaceTeamMemberRecordRow | null> {
      const rows = await db
        .insert(workspaceTeamMembers)
        .values({
          workspaceId,
          teamId,
          membershipId,
          teamRole,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .onConflictDoNothing()
        .returning()
      const row = rows[0]
      if (!row) {
        const current = await this.listMembers(db, workspaceId, teamId)
        return current.find((member) => member.membershipId === membershipId) ?? null
      }
      return {
        id: row.id,
        teamId: row.teamId,
        membershipId: row.membershipId,
        teamRole: row.teamRole,
        userId: null,
        email: null,
        name: null,
        workspaceRole: null,
        createdAt: isoRequired(row.createdAt),
      }
    },

    async removeMember(
      db: Database,
      workspaceId: string,
      teamId: string,
      membershipId: string,
      actorId?: string,
    ): Promise<boolean> {
      const deletedAt = new Date()
      const rows = await db
        .update(workspaceTeamMembers)
        .set({
          deletedAt,
          updatedAt: deletedAt,
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(
          and(
            eq(workspaceTeamMembers.teamId, teamId),
            eq(workspaceTeamMembers.membershipId, membershipId),
            eq(workspaceTeamMembers.workspaceId, workspaceId),
            isNull(workspaceTeamMembers.deletedAt),
          ),
        )
        .returning()
      return rows.length > 0
    },
  }
}

function toTeamRow(
  row: {
    id: string
    workspaceId: string
    name: string
    slug: string
    description: string | null
    createdAt: Date | string
    updatedAt: Date | string
  },
  memberCount: number,
): WorkspaceTeamRecordRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    memberCount,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  }
}

export type WorkspaceTeamRepository = ReturnType<typeof createWorkspaceTeamRepository>
