import { PermissionDeniedError, requirePermission } from "@yourcrm/permissions"
import {
  checkWorkspaceInviteRole,
  checkWorkspaceMemberActivation,
  checkWorkspaceRoleChange,
  type RoleGuardVerdict,
} from "./roles"
import {
  workspaceInviteCreateSchema,
  workspaceInviteQuerySchema,
  workspaceMemberQuerySchema,
  workspaceMemberRolePatchSchema,
  workspaceSettingsPatchSchema,
} from "./schemas"
import type {
  SettingsPage,
  SettingsServiceContext,
  WorkspaceInviteRecord,
  WorkspaceMemberRecord,
  WorkspaceSettingsRecord,
  WorkspaceSettingsServiceDeps,
} from "./types"

/**
 * Workspace settings + member management service (specs 40 + 41, P0).
 *
 * THE RISK IN THIS MODULE IS PRIVILEGE ESCALATION, so every mutation runs
 * two gates, in this order:
 *
 *   1. `requirePermission({ action: "admin" })` — the shared role-rank
 *      policy. Members and viewers never get past this line.
 *   2. A relational guard from `./roles.ts` — self-promotion, owner
 *      protection, granting above your own rank, and removing the last
 *      owner. `@yourcrm/permissions` cannot express these because they
 *      depend on the target row and on the rest of the workspace.
 *
 * Both denials surface as the same `PermissionDeniedError` (HTTP 403), so a
 * blocked escalation is indistinguishable from a blocked role — an attacker
 * learns nothing from the status code.
 *
 * Every mutation writes an audit row through the injected `AuditWriter`.
 * This is the module that proves the audit trail works, so the rule here is
 * absolute: no settings write returns without an audit row.
 *
 * INVITES ARE TOKENS, NOT PASSWORDS. `invite()` generates a 32-byte CSPRNG
 * token, returns it to the caller exactly once and persists only
 * `hash(token)` with an expiry. Nothing in this service, the repository or
 * the API can read a raw token back; "resend" mints a new one and kills the
 * old link by overwriting the hash.
 *
 * EXTENSION POINTS (explicitly out of P0 scope, spec 40 §3): SAML/OIDC SSO,
 * SCIM provisioning, TOTP/passkey MFA, IP allowlists and encryption-key
 * rotation. Each is a new table plus a policy check at login; none of them
 * changes the shape of this service, and none is stubbed here — a stub
 * would look like a security control that is not one.
 *
 * BLOCKER (reported, not worked around): `@yourcrm/events` has no
 * settings/team/security event group (no `security.setting_changed`,
 * `user.invited`, `role.updated`, `team.member_added`), and this module may
 * not add one or use string literals. So it emits no domain events in P0 and
 * audits every mutation instead.
 */

const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export class WorkspaceSettingsNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(workspaceId: string) {
    super(`workspace ${workspaceId} not found`)
    this.name = "WorkspaceSettingsNotFoundError"
  }
}

export class WorkspaceMemberNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(membershipId: string) {
    super(`membership ${membershipId} not found`)
    this.name = "WorkspaceMemberNotFoundError"
  }
}

export class WorkspaceInviteNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`invitation ${id} not found`)
    this.name = "WorkspaceInviteNotFoundError"
  }
}

export class WorkspaceInviteConflictError extends Error {
  readonly code = "CONFLICT"
  constructor(email: string) {
    super(`an invitation for ${email} is already pending — resend or revoke it`)
    this.name = "WorkspaceInviteConflictError"
  }
}

function permissionOf(ctx: SettingsServiceContext, object: string) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object,
    action: "admin" as const,
  }
}

/** Turn a role-guard denial into the shared 403 error. */
function enforce(
  ctx: SettingsServiceContext,
  object: string,
  verdict: RoleGuardVerdict,
  recordId?: string,
): void {
  if (verdict.allowed) return
  throw new PermissionDeniedError(
    { ...permissionOf(ctx, object), ...(recordId === undefined ? {} : { recordId }) },
    verdict.reason,
  )
}

export function createWorkspaceSettingsService(deps: WorkspaceSettingsServiceDeps) {
  const now = deps.now ?? (() => new Date())
  const ttl = deps.inviteTtlMs ?? DEFAULT_INVITE_TTL_MS

  // --- workspace profile ---------------------------------------------------

  async function getWorkspace(ctx: SettingsServiceContext): Promise<WorkspaceSettingsRecord> {
    requirePermission(permissionOf(ctx, "workspace_settings"))
    const found = await deps.store.getWorkspace(ctx.workspaceId)
    if (!found) throw new WorkspaceSettingsNotFoundError(ctx.workspaceId)
    return found
  }

  async function updateWorkspace(
    ctx: SettingsServiceContext,
    rawPatch: unknown,
  ): Promise<WorkspaceSettingsRecord> {
    requirePermission(permissionOf(ctx, "workspace_settings"))
    const patch = workspaceSettingsPatchSchema.parse(rawPatch)
    const before = await deps.store.getWorkspace(ctx.workspaceId)
    if (!before) throw new WorkspaceSettingsNotFoundError(ctx.workspaceId)
    const after = await deps.store.updateWorkspace(ctx.workspaceId, patch, ctx.actorId)
    if (!after) throw new WorkspaceSettingsNotFoundError(ctx.workspaceId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "settings.update",
      object: "workspace_settings",
      recordId: ctx.workspaceId,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  // --- members -------------------------------------------------------------

  async function listMembers(
    ctx: SettingsServiceContext,
    rawQuery: unknown,
  ): Promise<SettingsPage<WorkspaceMemberRecord>> {
    requirePermission(permissionOf(ctx, "membership"))
    const query = workspaceMemberQuerySchema.parse(rawQuery)
    return deps.store.listMembers(ctx.workspaceId, query)
  }

  async function getMember(
    ctx: SettingsServiceContext,
    membershipId: string,
  ): Promise<WorkspaceMemberRecord> {
    requirePermission(permissionOf(ctx, "membership"))
    const found = await deps.store.findMember(ctx.workspaceId, membershipId)
    if (!found) throw new WorkspaceMemberNotFoundError(membershipId)
    return found
  }

  /**
   * Change a member's workspace role.
   *
   * Denied for: changing your own role (self-escalation), touching an owner
   * while not an owner, granting a role above your own, and demoting the
   * last owner. See `./roles.ts` for why each one matters.
   */
  async function changeMemberRole(
    ctx: SettingsServiceContext,
    membershipId: string,
    rawPatch: unknown,
  ): Promise<WorkspaceMemberRecord> {
    requirePermission(permissionOf(ctx, "membership"))
    const { role } = workspaceMemberRolePatchSchema.parse(rawPatch)
    const before = await deps.store.findMember(ctx.workspaceId, membershipId)
    if (!before) throw new WorkspaceMemberNotFoundError(membershipId)
    const activeOwnerCount = await deps.store.countActiveOwners(ctx.workspaceId)
    enforce(
      ctx,
      "membership",
      checkWorkspaceRoleChange({
        actorId: ctx.actorId,
        actorRole: ctx.role ?? "viewer",
        target: {
          membershipId: before.membershipId,
          userId: before.userId,
          role: before.role,
          active: before.active,
        },
        nextRole: role,
        activeOwnerCount,
      }),
      membershipId,
    )
    const after = await deps.store.updateMemberRole(
      ctx.workspaceId,
      membershipId,
      role,
      ctx.actorId,
    )
    if (!after) throw new WorkspaceMemberNotFoundError(membershipId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "membership.role_changed",
      object: "membership",
      recordId: membershipId,
      before: { role: before.role },
      after: { role: after.role },
      correlationId: ctx.correlationId,
    })
    return after
  }

  /** Deactivate (soft-delete) or reactivate a membership. */
  async function setMemberActive(
    ctx: SettingsServiceContext,
    membershipId: string,
    active: boolean,
  ): Promise<WorkspaceMemberRecord> {
    requirePermission(permissionOf(ctx, "membership"))
    const before = await deps.store.findMember(ctx.workspaceId, membershipId)
    if (!before) throw new WorkspaceMemberNotFoundError(membershipId)
    const activeOwnerCount = await deps.store.countActiveOwners(ctx.workspaceId)
    enforce(
      ctx,
      "membership",
      checkWorkspaceMemberActivation({
        actorId: ctx.actorId,
        actorRole: ctx.role ?? "viewer",
        target: {
          membershipId: before.membershipId,
          userId: before.userId,
          role: before.role,
          active: before.active,
        },
        active,
        activeOwnerCount,
      }),
      membershipId,
    )
    const after = await deps.store.setMemberActive(
      ctx.workspaceId,
      membershipId,
      active,
      ctx.actorId,
    )
    if (!after) throw new WorkspaceMemberNotFoundError(membershipId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: active ? "membership.reactivated" : "membership.deactivated",
      object: "membership",
      recordId: membershipId,
      before: { active: before.active },
      after: { active: after.active },
      correlationId: ctx.correlationId,
    })
    return after
  }

  // --- invitations ---------------------------------------------------------

  async function listInvites(
    ctx: SettingsServiceContext,
    rawQuery: unknown,
  ): Promise<SettingsPage<WorkspaceInviteRecord>> {
    requirePermission(permissionOf(ctx, "workspace_invite"))
    const query = workspaceInviteQuerySchema.parse(rawQuery)
    return deps.store.listInvites(ctx.workspaceId, query)
  }

  /**
   * Invite somebody. Returns the invite row plus the raw token, which is the
   * ONLY moment that value exists: the caller delivers it (email, link) and
   * the store keeps only its hash.
   */
  async function invite(
    ctx: SettingsServiceContext,
    rawInput: unknown,
  ): Promise<{ invite: WorkspaceInviteRecord; token: string }> {
    requirePermission(permissionOf(ctx, "workspace_invite"))
    const input = workspaceInviteCreateSchema.parse(rawInput)
    enforce(
      ctx,
      "workspace_invite",
      checkWorkspaceInviteRole({
        actorId: ctx.actorId,
        actorRole: ctx.role ?? "viewer",
        role: input.role,
      }),
    )
    const pending = await deps.store.findPendingInviteByEmail(ctx.workspaceId, input.email)
    if (pending) throw new WorkspaceInviteConflictError(input.email)
    const token = deps.tokens.generate()
    const created = await deps.store.createInvite(
      ctx.workspaceId,
      {
        email: input.email,
        role: input.role,
        tokenHash: deps.tokens.hash(token),
        expiresAt: new Date(now().getTime() + ttl),
        invitedBy: ctx.actorId,
      },
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "invite.created",
      object: "workspace_invite",
      recordId: created.id,
      // Email and role only: an audit row must never carry the credential.
      after: { email: created.email, role: created.role, expiresAt: created.expiresAt },
      correlationId: ctx.correlationId,
    })
    return { invite: created, token }
  }

  /** Resend: mint a new token and expiry, invalidating the previous link. */
  async function resendInvite(
    ctx: SettingsServiceContext,
    id: string,
  ): Promise<{ invite: WorkspaceInviteRecord; token: string }> {
    requirePermission(permissionOf(ctx, "workspace_invite"))
    const before = await deps.store.findInvite(ctx.workspaceId, id)
    if (!before) throw new WorkspaceInviteNotFoundError(id)
    enforce(
      ctx,
      "workspace_invite",
      checkWorkspaceInviteRole({
        actorId: ctx.actorId,
        actorRole: ctx.role ?? "viewer",
        role: before.role,
      }),
      id,
    )
    const token = deps.tokens.generate()
    const rotated = await deps.store.rotateInviteToken(
      ctx.workspaceId,
      id,
      deps.tokens.hash(token),
      new Date(now().getTime() + ttl),
      ctx.actorId,
    )
    if (!rotated) throw new WorkspaceInviteNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "invite.resent",
      object: "workspace_invite",
      recordId: id,
      before: { expiresAt: before.expiresAt },
      after: { email: rotated.email, role: rotated.role, expiresAt: rotated.expiresAt },
      correlationId: ctx.correlationId,
    })
    return { invite: rotated, token }
  }

  async function revokeInvite(
    ctx: SettingsServiceContext,
    id: string,
  ): Promise<WorkspaceInviteRecord> {
    requirePermission(permissionOf(ctx, "workspace_invite"))
    const before = await deps.store.findInvite(ctx.workspaceId, id)
    if (!before) throw new WorkspaceInviteNotFoundError(id)
    const revoked = await deps.store.revokeInvite(ctx.workspaceId, id, ctx.actorId)
    if (!revoked) throw new WorkspaceInviteNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "invite.revoked",
      object: "workspace_invite",
      recordId: id,
      before: { email: before.email, role: before.role },
      after: { revokedAt: revoked.revokedAt },
      correlationId: ctx.correlationId,
    })
    return revoked
  }

  return {
    getWorkspace,
    updateWorkspace,
    listMembers,
    getMember,
    changeMemberRole,
    setMemberActive,
    listInvites,
    invite,
    resendInvite,
    revokeInvite,
  }
}

export type WorkspaceSettingsService = ReturnType<typeof createWorkspaceSettingsService>
