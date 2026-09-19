import { requirePermission } from "@yourcrm/permissions"
import {
  workspaceTeamCreateSchema,
  workspaceTeamMemberAddSchema,
  workspaceTeamPatchSchema,
  workspaceTeamQuerySchema,
} from "./schemas"
import type {
  SettingsPage,
  SettingsServiceContext,
  WorkspaceTeamMemberRecord,
  WorkspaceTeamRecord,
  WorkspaceTeamServiceDeps,
} from "./types"

/**
 * Teams service (spec 41, P0).
 *
 * A team groups memberships for ownership and visibility. It is explicitly
 * NOT a role: nothing here reads or writes `memberships.role`, and
 * `teamRole` ("member" | "lead") carries no permission rank, so adding
 * somebody to a team can never be an escalation path. That is why the
 * team-member write only needs the module's admin gate and a workspace
 * check on the membership — there is no privilege to compare.
 *
 * Nested teams (spec 41 §3) are P1: the table has no parent column yet, and
 * adding one later is additive. Record-visibility rules *driven* by teams
 * belong to the modules that own those records; this module supplies the
 * grouping and the membership edge they will read.
 */

export class WorkspaceTeamNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`team ${id} not found`)
    this.name = "WorkspaceTeamNotFoundError"
  }
}

export class WorkspaceTeamMembershipError extends Error {
  readonly code = "VALIDATION_ERROR"
  constructor(membershipId: string) {
    super(`membership ${membershipId} does not belong to this workspace`)
    this.name = "WorkspaceTeamMembershipError"
  }
}

function slugFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug.slice(0, 255) : "team"
}

function permissionOf(ctx: SettingsServiceContext) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "team",
    action: "admin" as const,
  }
}

export function createWorkspaceTeamService(deps: WorkspaceTeamServiceDeps) {
  async function list(
    ctx: SettingsServiceContext,
    rawQuery: unknown,
  ): Promise<SettingsPage<WorkspaceTeamRecord>> {
    requirePermission(permissionOf(ctx))
    const query = workspaceTeamQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(
    ctx: SettingsServiceContext,
    id: string,
  ): Promise<{ team: WorkspaceTeamRecord; members: WorkspaceTeamMemberRecord[] }> {
    requirePermission(permissionOf(ctx))
    const team = await deps.store.findById(ctx.workspaceId, id)
    if (!team) throw new WorkspaceTeamNotFoundError(id)
    const members = await deps.store.listMembers(ctx.workspaceId, id)
    return { team, members }
  }

  async function create(
    ctx: SettingsServiceContext,
    rawInput: unknown,
  ): Promise<WorkspaceTeamRecord> {
    requirePermission(permissionOf(ctx))
    const input = workspaceTeamCreateSchema.parse(rawInput)
    const team = await deps.store.create(
      ctx.workspaceId,
      {
        name: input.name,
        slug: input.slug ?? slugFromName(input.name),
        description: input.description ?? null,
      },
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "team.created",
      object: "team",
      recordId: team.id,
      after: team,
      correlationId: ctx.correlationId,
    })
    return team
  }

  async function update(
    ctx: SettingsServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<WorkspaceTeamRecord> {
    requirePermission(permissionOf(ctx))
    const patch = workspaceTeamPatchSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new WorkspaceTeamNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.slug === undefined ? {} : { slug: patch.slug }),
        ...(patch.description === undefined ? {} : { description: patch.description ?? null }),
      },
      ctx.actorId,
    )
    if (!after) throw new WorkspaceTeamNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "team.updated",
      object: "team",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /** Soft delete — the team and its edges stay auditable. */
  async function softDelete(ctx: SettingsServiceContext, id: string): Promise<WorkspaceTeamRecord> {
    requirePermission(permissionOf(ctx))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new WorkspaceTeamNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "team.deleted",
      object: "team",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function addMember(
    ctx: SettingsServiceContext,
    teamId: string,
    rawInput: unknown,
  ): Promise<WorkspaceTeamMemberRecord> {
    requirePermission(permissionOf(ctx))
    const input = workspaceTeamMemberAddSchema.parse(rawInput)
    const team = await deps.store.findById(ctx.workspaceId, teamId)
    if (!team) throw new WorkspaceTeamNotFoundError(teamId)
    // Cross-workspace guard: the membership must live in THIS workspace.
    const exists = await deps.store.membershipExists(ctx.workspaceId, input.membershipId)
    if (!exists) throw new WorkspaceTeamMembershipError(input.membershipId)
    const added = await deps.store.addMember(
      ctx.workspaceId,
      teamId,
      input.membershipId,
      input.teamRole,
      ctx.actorId,
    )
    if (!added) throw new WorkspaceTeamMembershipError(input.membershipId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "team.member_added",
      object: "team",
      recordId: teamId,
      after: { membershipId: input.membershipId, teamRole: input.teamRole },
      correlationId: ctx.correlationId,
    })
    return added
  }

  async function removeMember(
    ctx: SettingsServiceContext,
    teamId: string,
    membershipId: string,
  ): Promise<{ removed: boolean }> {
    requirePermission(permissionOf(ctx))
    const team = await deps.store.findById(ctx.workspaceId, teamId)
    if (!team) throw new WorkspaceTeamNotFoundError(teamId)
    const removed = await deps.store.removeMember(
      ctx.workspaceId,
      teamId,
      membershipId,
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "team.member_removed",
      object: "team",
      recordId: teamId,
      before: { membershipId },
      after: { removed },
      correlationId: ctx.correlationId,
    })
    return { removed }
  }

  return { list, get, create, update, softDelete, addMember, removeMember }
}

export type WorkspaceTeamService = ReturnType<typeof createWorkspaceTeamService>
