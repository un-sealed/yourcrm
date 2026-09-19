/**
 * Privilege-escalation rules for workspace membership (specs 40 + 41, P0).
 *
 * THIS IS THE SECURITY CORE OF THE MODULE.
 *
 * `@yourcrm/permissions` answers "may this actor administer the workspace at
 * all?" (role rank vs. required rank). It cannot answer the questions member
 * management actually turns on, because those depend on the *target* row and
 * on the rest of the workspace:
 *
 *   - may I change MY OWN role?                      -> never
 *   - may I change an OWNER's role / deactivate one? -> only if I am an owner
 *   - may I grant a role ABOVE my own?               -> never
 *   - may I remove the LAST owner?                   -> never, by anyone
 *
 * Without the last rule a workspace can be orphaned: no owner left, and
 * nobody able to create one. Without the first three, "admin" silently means
 * "owner", because an admin could promote themselves or demote the owner.
 *
 * These are pure functions over a described attempt so they are exhaustively
 * unit-testable without a database, and the service layer turns a denial into
 * the shared `PermissionDeniedError` (HTTP 403). They never *grant* anything:
 * a caller must already have passed `requirePermission()` before asking.
 */

/** Workspace access roles, highest first. Mirrors `memberships.role`. */
export const WORKSPACE_MEMBER_ROLES = ["owner", "admin", "member", "viewer"] as const

export type WorkspaceMemberRoleName = (typeof WORKSPACE_MEMBER_ROLES)[number]

export function isWorkspaceMemberRoleName(value: unknown): value is WorkspaceMemberRoleName {
  return typeof value === "string" && (WORKSPACE_MEMBER_ROLES as readonly string[]).includes(value)
}

/**
 * Rank ladder. Deliberately the same ordering as `ROLE_RANK` in
 * `@yourcrm/permissions/policy.ts` — this module compares two roles to each
 * other, which that package does not expose; it does not redefine who may do
 * what.
 */
const MEMBER_ROLE_RANK: Record<WorkspaceMemberRoleName, number> = {
  owner: 100,
  admin: 80,
  member: 40,
  viewer: 10,
}

/** Rank of a role string; unknown roles rank lowest (fail closed). */
export function workspaceRoleRank(role: string | null | undefined): number {
  if (!isWorkspaceMemberRoleName(role)) return 0
  return MEMBER_ROLE_RANK[role]
}

export type RoleGuardActor = {
  actorId: string
  /** The actor's role in this workspace, as resolved from their session. */
  actorRole: string
}

export type RoleGuardTarget = {
  membershipId: string
  userId: string
  role: string
  active: boolean
}

export type RoleGuardVerdict = { allowed: true } | { allowed: false; reason: string }

const ALLOWED: RoleGuardVerdict = { allowed: true }

function denied(reason: string): RoleGuardVerdict {
  return { allowed: false, reason }
}

export type RoleChangeAttempt = RoleGuardActor & {
  target: RoleGuardTarget
  nextRole: string
  /** Live owners in the workspace right now, counted from the database. */
  activeOwnerCount: number
}

/**
 * May `actor` set `target.role` to `nextRole`?
 *
 * Order matters: the self rule comes first so that "I promoted myself" is
 * reported as exactly that, and the last-owner rule comes last so it is only
 * reached by someone otherwise entitled to touch an owner.
 */
export function checkWorkspaceRoleChange(attempt: RoleChangeAttempt): RoleGuardVerdict {
  const { actorId, actorRole, target, nextRole, activeOwnerCount } = attempt

  if (!isWorkspaceMemberRoleName(nextRole)) {
    return denied(`'${nextRole}' is not a workspace role`)
  }

  // 1. Self-escalation. No self role change at all: "raise" is the attack,
  //    and a self-demotion is the last-owner problem wearing a disguise.
  if (target.userId === actorId) {
    return denied("you cannot change your own role — ask another owner")
  }

  // 2. Owner protection: only an owner may re-rank an owner.
  if (target.role === "owner" && actorRole !== "owner") {
    return denied("only an owner can change an owner's role")
  }

  // 3. No granting above your own rank (an admin cannot mint an owner).
  if (workspaceRoleRank(nextRole) > workspaceRoleRank(actorRole)) {
    return denied(`you cannot grant the '${nextRole}' role — it outranks yours`)
  }

  // 4. The workspace must keep at least one live owner.
  if (target.role === "owner" && nextRole !== "owner" && activeOwnerCount <= 1) {
    return denied("the last owner cannot be demoted — promote another owner first")
  }

  if (target.role === nextRole) return denied(`this member is already '${nextRole}'`)

  return ALLOWED
}

export type MemberActivationAttempt = RoleGuardActor & {
  target: RoleGuardTarget
  /** True to reactivate, false to deactivate. */
  active: boolean
  activeOwnerCount: number
}

/**
 * May `actor` deactivate/reactivate `target`?
 *
 * Deactivation is a soft delete of the membership, so it removes an owner
 * just as effectively as a demotion does — the same three guards apply.
 */
export function checkWorkspaceMemberActivation(attempt: MemberActivationAttempt): RoleGuardVerdict {
  const { actorId, actorRole, target, active, activeOwnerCount } = attempt

  if (target.userId === actorId) {
    return denied("you cannot deactivate or reactivate your own membership")
  }

  // Re-enabling an owner is as privileged as demoting one.
  if (target.role === "owner" && actorRole !== "owner") {
    return denied("only an owner can deactivate or reactivate an owner")
  }

  if (!active && target.role === "owner" && activeOwnerCount <= 1) {
    return denied("the last owner cannot be deactivated — promote another owner first")
  }

  if (target.active === active) {
    return denied(active ? "this member is already active" : "this member is already inactive")
  }

  return ALLOWED
}

export type InviteRoleAttempt = RoleGuardActor & { role: string }

/**
 * May `actor` invite somebody at `role`? An invitation is a future
 * membership, so it obeys the same ceiling: you cannot invite above your own
 * rank, or a workspace could be taken over by inviting a fresh owner.
 */
export function checkWorkspaceInviteRole(attempt: InviteRoleAttempt): RoleGuardVerdict {
  if (!isWorkspaceMemberRoleName(attempt.role)) {
    return denied(`'${attempt.role}' is not a workspace role`)
  }
  if (workspaceRoleRank(attempt.role) > workspaceRoleRank(attempt.actorRole)) {
    return denied(`you cannot invite somebody as '${attempt.role}' — it outranks you`)
  }
  return ALLOWED
}

/**
 * Is a presented invite usable? Pure, so the expiry/consumption rules are
 * tested without a clock or a database. The caller has already matched the
 * token hash — this decides whether the matched row still counts.
 */
export function checkInviteUsable(
  invite: { expiresAt: string; acceptedAt: string | null; revokedAt: string | null },
  now: Date,
): RoleGuardVerdict {
  if (invite.revokedAt !== null) return denied("this invitation was revoked")
  if (invite.acceptedAt !== null) return denied("this invitation was already used")
  const expiresAt = new Date(invite.expiresAt)
  if (Number.isNaN(expiresAt.getTime())) return denied("this invitation has no valid expiry")
  if (expiresAt.getTime() <= now.getTime()) return denied("this invitation has expired")
  return ALLOWED
}
