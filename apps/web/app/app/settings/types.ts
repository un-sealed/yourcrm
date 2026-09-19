import type { BadgeTone } from "@yourcrm/ui"

/**
 * Settings API shapes and presentation helpers (specs 40 + 41, P0).
 *
 * Pure functions only, so the formatting and query-building logic is unit
 * tested without a browser (`types.test.ts`).
 *
 * The role `<select>` in the members table is a CONVENIENCE, not a security
 * boundary: the server re-checks every escalation rule (self-promotion,
 * owner protection, last owner) and answers 403. This file therefore hides
 * options to reduce mistakes, and the UI always renders the server's error.
 */

export const SETTINGS_SECTIONS = [
  { value: "workspace", label: "Workspace" },
  { value: "members", label: "Members" },
  { value: "teams", label: "Teams" },
  { value: "audit", label: "Audit log" },
  { value: "privacy", label: "Data & privacy" },
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["value"]

export function isSettingsSection(value: string | null): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section.value === value)
}

export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer"] as const

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

export type WorkspaceSettings = {
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

export type WorkspaceMember = {
  membershipId: string
  userId: string
  email: string
  name: string | null
  role: string
  active: boolean
  joinedAt: string
  lastLoginAt: string | null
}

export type WorkspaceInvite = {
  id: string
  email: string
  role: string
  expiresAt: string
  acceptedAt: string | null
  revokedAt: string | null
  createdAt: string
  /** Present ONLY in the create/resend response — never in a listing. */
  token?: string
}

export type WorkspaceTeam = {
  id: string
  name: string
  slug: string
  description: string | null
  memberCount: number
  createdAt: string
}

export type WorkspaceTeamMember = {
  id: string
  membershipId: string
  teamRole: string
  email: string | null
  name: string | null
  workspaceRole: string | null
}

export type AuditEvent = {
  id: string
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

export type DataRequest = {
  id: string
  kind: string
  subjectType: string
  subjectId: string
  status: string
  reason: string | null
  completedAt: string | null
  createdAt: string
}

export type Paginated<T> = {
  data: T[]
  pagination: { nextCursor: string | null; limit: number }
}

export function formatSettingsTimestamp(value: string | null): string {
  if (!value) return "—"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return "—"
  return parsed.toLocaleString()
}

/** Tone plus the role WORD — never colour alone (a11y). */
export function roleTone(role: string): BadgeTone {
  switch (role) {
    case "owner":
      return "warning"
    case "admin":
      return "info"
    case "viewer":
      return "secondary"
    default:
      return "success"
  }
}

export function memberStatusLabel(member: Pick<WorkspaceMember, "active">): string {
  return member.active ? "Active" : "Deactivated"
}

/**
 * Roles the current actor may hand out: never above their own rank. The
 * server enforces the same ceiling — this only keeps the menu honest.
 */
export function assignableRoles(actorRole: string): WorkspaceRole[] {
  const order: WorkspaceRole[] = ["owner", "admin", "member", "viewer"]
  const index = order.indexOf(actorRole as WorkspaceRole)
  return index < 0 ? [] : order.slice(index)
}

export type InviteState = "pending" | "expired" | "revoked" | "accepted"

export function inviteState(invite: WorkspaceInvite, now: Date = new Date()): InviteState {
  if (invite.revokedAt) return "revoked"
  if (invite.acceptedAt) return "accepted"
  const expiresAt = new Date(invite.expiresAt)
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) return "expired"
  return "pending"
}

export function inviteStateTone(state: InviteState): BadgeTone {
  switch (state) {
    case "pending":
      return "info"
    case "accepted":
      return "success"
    case "expired":
      return "warning"
    case "revoked":
      return "secondary"
  }
}

export type AuditFilters = {
  object: string
  action: string
  source: string
  from: string
  to: string
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = {
  object: "",
  action: "",
  source: "",
  from: "",
  to: "",
}

/** Mirrors `workspaceAuditQuerySchema`; empty fields are omitted entirely. */
export function auditQueryString(filters: AuditFilters, cursor: string | null, limit = 25): string {
  const params = new URLSearchParams({ limit: String(limit) })
  if (filters.object) params.set("object", filters.object)
  if (filters.action) params.set("action", filters.action)
  if (filters.source) params.set("source", filters.source)
  // `date` inputs give YYYY-MM-DD; the API wants a full ISO timestamp.
  if (filters.from) params.set("from", `${filters.from}T00:00:00.000Z`)
  if (filters.to) params.set("to", `${filters.to}T23:59:59.999Z`)
  if (cursor) params.set("cursor", cursor)
  return params.toString()
}

/** One-line, human-readable summary of an audit row. */
export function describeAuditEvent(event: AuditEvent): string {
  const object = event.object.replace(/_/g, " ")
  const action = event.action.replace(/[._]/g, " ")
  return event.recordId ? `${action} on ${object} ${event.recordId}` : `${action} on ${object}`
}

/** Changed keys between the before/after snapshots, for the detail row. */
export function auditChangedKeys(event: AuditEvent): string[] {
  const before = isRecord(event.before) ? event.before : {}
  const after = isRecord(event.after) ? event.after : {}
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const DATA_REQUEST_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  fulfilled: "Fulfilled",
  soft_deleted: "Soft-deleted (awaiting purge policy)",
  rejected: "Rejected",
}

export function dataRequestStatusLabel(status: string): string {
  return DATA_REQUEST_STATUS_LABELS[status] ?? status
}

export function dataRequestStatusTone(status: string): BadgeTone {
  switch (status) {
    case "fulfilled":
      return "success"
    case "soft_deleted":
      return "warning"
    case "rejected":
      return "destructive"
    default:
      return "info"
  }
}
