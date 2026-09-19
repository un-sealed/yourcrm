import type { ServiceContext } from "../index"
import type { AuditWriter } from "../ports"

/**
 * Settings, security & compliance ports (specs 40 + 41, P0).
 *
 * `@yourcrm/crm` has no database and no auth dependency, so this module
 * depends on structural ports only: the API layer adapts the drizzle
 * repositories (`settings-repository.ts`, `teams-repository.ts`,
 * `compliance-repository.ts`), `writeAudit` and `@yourcrm/auth`'s token
 * helpers to them, and the hermetic tests satisfy the same shapes in memory.
 *
 * Two of these ports exist for a security reason rather than a testing one:
 *
 *  - `WorkspaceAuditLogPort` has **no** update/delete/soft-delete method, so
 *    no audit row can be modified through this module. Append-only is a
 *    property of the type, not a habit of the caller.
 *  - `WorkspaceInviteTokenPort` hands the service a *hash*: the service
 *    generates a raw token, returns it once to the caller and stores only
 *    `hash(token)`. It has no way to read a stored token back.
 */

export type SettingsServiceContext = ServiceContext

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type SettingsAuditInput = {
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

export type SettingsPage<T> = {
  data: T[]
  pagination: { nextCursor: string | null; limit: number }
}

// ---------------------------------------------------------------------------
// Workspace profile
// ---------------------------------------------------------------------------

export type WorkspaceSettingsRecord = {
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

export type WorkspaceSettingsPatch = {
  name?: string
  timezone?: string
  currency?: string
  dateFormat?: string
  logoUrl?: string | null
  brandColor?: string | null
  supportEmail?: string | null
}

export type WorkspaceProfileStore = {
  getWorkspace(workspaceId: string): Promise<WorkspaceSettingsRecord | null>
  updateWorkspace(
    workspaceId: string,
    patch: WorkspaceSettingsPatch,
    actorId?: string,
  ): Promise<WorkspaceSettingsRecord | null>
}

// ---------------------------------------------------------------------------
// Members + invitations
// ---------------------------------------------------------------------------

export type WorkspaceMemberRecord = {
  membershipId: string
  userId: string
  email: string
  name: string | null
  role: string
  active: boolean
  joinedAt: string
  lastLoginAt: string | null
}

export type WorkspaceMemberQuery = {
  limit?: number
  cursor?: string | null
  query?: string
  role?: string
  status?: "active" | "inactive"
}

/** Never carries `tokenHash` — the projection has no field for it. */
export type WorkspaceInviteRecord = {
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

export type WorkspaceMemberStore = {
  listMembers(
    workspaceId: string,
    query: WorkspaceMemberQuery,
  ): Promise<SettingsPage<WorkspaceMemberRecord>>
  findMember(workspaceId: string, membershipId: string): Promise<WorkspaceMemberRecord | null>
  countActiveOwners(workspaceId: string): Promise<number>
  updateMemberRole(
    workspaceId: string,
    membershipId: string,
    role: string,
    actorId?: string,
  ): Promise<WorkspaceMemberRecord | null>
  setMemberActive(
    workspaceId: string,
    membershipId: string,
    active: boolean,
    actorId?: string,
  ): Promise<WorkspaceMemberRecord | null>
}

export type WorkspaceInviteStore = {
  listInvites(
    workspaceId: string,
    query: { limit?: number; cursor?: string | null; state?: "pending" | "all" },
  ): Promise<SettingsPage<WorkspaceInviteRecord>>
  findInvite(workspaceId: string, id: string): Promise<WorkspaceInviteRecord | null>
  findPendingInviteByEmail(
    workspaceId: string,
    email: string,
  ): Promise<WorkspaceInviteRecord | null>
  createInvite(
    workspaceId: string,
    input: {
      email: string
      role: string
      tokenHash: string
      expiresAt: Date
      invitedBy?: string | null
    },
    actorId?: string,
  ): Promise<WorkspaceInviteRecord>
  rotateInviteToken(
    workspaceId: string,
    id: string,
    tokenHash: string,
    expiresAt: Date,
    actorId?: string,
  ): Promise<WorkspaceInviteRecord | null>
  revokeInvite(
    workspaceId: string,
    id: string,
    actorId?: string,
  ): Promise<WorkspaceInviteRecord | null>
}

/**
 * Token primitives, injected so the domain layer stays free of
 * `@yourcrm/auth` (which `@yourcrm/crm` does not depend on). The API binds
 * these to `generateSessionToken` / `hashSessionToken` — the same 32-byte
 * CSPRNG + SHA-256 pair that backs session cookies.
 */
export type WorkspaceInviteTokenPort = {
  generate(): string
  hash(token: string): string
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export type WorkspaceTeamRecord = {
  id: string
  workspaceId: string
  name: string
  slug: string
  description: string | null
  memberCount: number
  createdAt: string
  updatedAt: string
}

export type WorkspaceTeamMemberRecord = {
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

export type WorkspaceTeamStore = {
  list(
    workspaceId: string,
    query: { limit?: number; cursor?: string | null; query?: string },
  ): Promise<SettingsPage<WorkspaceTeamRecord>>
  findById(workspaceId: string, id: string): Promise<WorkspaceTeamRecord | null>
  create(
    workspaceId: string,
    input: { name: string; slug: string; description?: string | null },
    actorId?: string,
  ): Promise<WorkspaceTeamRecord>
  update(
    workspaceId: string,
    id: string,
    input: { name?: string; slug?: string; description?: string | null },
    actorId?: string,
  ): Promise<WorkspaceTeamRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  listMembers(workspaceId: string, teamId: string): Promise<WorkspaceTeamMemberRecord[]>
  membershipExists(workspaceId: string, membershipId: string): Promise<boolean>
  addMember(
    workspaceId: string,
    teamId: string,
    membershipId: string,
    teamRole: string,
    actorId?: string,
  ): Promise<WorkspaceTeamMemberRecord | null>
  removeMember(
    workspaceId: string,
    teamId: string,
    membershipId: string,
    actorId?: string,
  ): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Compliance: audit log + data requests
// ---------------------------------------------------------------------------

export type WorkspaceAuditRecord = {
  id: string
  workspaceId: string
  actorId: string | null
  action: string
  object: string
  recordId: string | null
  before: unknown
  after: unknown
  correlationId: string | null
  source: string
  createdAt: string
}

export type WorkspaceAuditQuery = {
  limit?: number
  cursor?: string | null
  action?: string
  object?: string
  actorId?: string
  recordId?: string
  source?: string
  from?: string
  to?: string
  query?: string
}

/**
 * READ-ONLY audit port. Adding a mutating method here would be the bug —
 * `audit_events` is append-only (enforced by a trigger in
 * `0320_settings.sql`), and `writeAudit` is its only writer.
 */
export type WorkspaceAuditLogPort = {
  list(workspaceId: string, query: WorkspaceAuditQuery): Promise<SettingsPage<WorkspaceAuditRecord>>
  findById(workspaceId: string, id: string): Promise<WorkspaceAuditRecord | null>
}

export type DataRequestRecord = {
  id: string
  workspaceId: string
  kind: string
  subjectType: string
  subjectId: string
  status: string
  reason: string | null
  requestedBy: string | null
  completedAt: string | null
  completedBy: string | null
  createdAt: string
}

export type DataRequestStore = {
  list(
    workspaceId: string,
    query: { limit?: number; cursor?: string | null; kind?: string; status?: string },
  ): Promise<SettingsPage<DataRequestRecord>>
  findById(workspaceId: string, id: string): Promise<DataRequestRecord | null>
  create(
    workspaceId: string,
    input: {
      kind: string
      subjectType: string
      subjectId: string
      reason?: string | null
      status?: string
    },
    actorId?: string,
  ): Promise<DataRequestRecord>
  markStatus(
    workspaceId: string,
    id: string,
    status: string,
    actorId?: string,
  ): Promise<DataRequestRecord | null>
}

/**
 * The data subject, reached through the OWNING module's contract — the API
 * binds this to the people repository, never to raw SQL, so this module does
 * not read or write another module's tables directly.
 *
 * `softDelete` is a soft delete on purpose: P0 records the erasure request
 * and hides the record; the irreversible purge is a retention policy that
 * has not been written yet.
 */
export type DataSubjectPort = {
  load(workspaceId: string, subjectId: string): Promise<Record<string, unknown> | null>
  softDelete(workspaceId: string, subjectId: string, actorId?: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Service dependency bundles
// ---------------------------------------------------------------------------

export type WorkspaceSettingsServiceDeps = {
  store: WorkspaceProfileStore & WorkspaceMemberStore & WorkspaceInviteStore
  tokens: WorkspaceInviteTokenPort
  audit: AuditWriter<SettingsAuditInput>
  /** Invite lifetime; defaults to 7 days. */
  inviteTtlMs?: number
  /** Injectable clock (expiry maths is tested, not observed). */
  now?: () => Date
}

export type WorkspaceTeamServiceDeps = {
  store: WorkspaceTeamStore
  audit: AuditWriter<SettingsAuditInput>
}

export type ComplianceServiceDeps = {
  auditLog: WorkspaceAuditLogPort
  requests: DataRequestStore
  subjects: DataSubjectPort
  audit: AuditWriter<SettingsAuditInput>
}
