import type { BadgeTone } from "@yourcrm/ui"

/**
 * Client-side contracts for the AI approval queue.
 *
 * The server owns every decision here — this file only shapes what the
 * reviewer sees. Nothing in it may become a second permission check: the
 * page hides buttons for convenience, the API refuses for real.
 */

export type AiActionType = "create" | "update" | "delete" | "send_external"

export type AiActionRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "applied"
  | "reverted"
  | "expired"

export type AiActionApproval = {
  id: string
  decision: string
  approverId: string
  approverRole: string | null
  requesterRole: string | null
  reason: string | null
  createdAt: string
}

/** One proposed mutation, as `GET /api/v1/ai/governance/requests` returns it. */
export type AiActionRequest = {
  id: string
  workspaceId: string
  actorType: string
  actorId: string
  agentId: string | null
  model: string | null
  runId: string | null
  correlationId: string | null
  objectType: string
  recordId: string | null
  action: string
  before: unknown
  after: unknown
  rationale: string | null
  status: string
  policyMode: string
  requestedRole: string | null
  expiresAt: string | null
  decidedAt: string | null
  appliedAt: string | null
  applyError: string | null
  revertedAt: string | null
  createdAt: string
  updatedAt: string
  approval?: AiActionApproval | null
}

export type AiActionRequestsResponse = {
  data: AiActionRequest[]
  pagination: { nextCursor: string | null; limit: number }
}

export type AiGovernanceCatalogue = {
  actions: string[]
  statuses: string[]
  modes: { mode: string; label: string; detail: string }[]
  policyModes: string[]
  appliableObjects: string[]
}

export const AI_STATUS_TONES: Record<string, BadgeTone> = {
  pending: "warning",
  approved: "info",
  applied: "success",
  rejected: "destructive",
  reverted: "outline",
  expired: "secondary",
}

export const AI_ACTION_LABELS: Record<string, string> = {
  create: "Create",
  update: "Update",
  delete: "Delete",
  send_external: "Send externally",
}

/* ---------------------------------- diff ---------------------------------- */

export type AiDiffRow = {
  field: string
  before: string
  after: string
  changed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Render one value for a diff cell. `—` means "nothing here". */
export function formatAiValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

/**
 * Field-by-field diff of the recorded before/after.
 *
 * The union of both key sets, in a stable order, so a reviewer sees what
 * would be REMOVED as clearly as what would be added. A non-object payload
 * (a whole record being created or deleted) becomes a single `record` row,
 * because that is honestly what is changing.
 */
export function aiDiffRows(before: unknown, after: unknown): AiDiffRow[] {
  if (!isRecord(before) && !isRecord(after)) {
    const beforeText = formatAiValue(before)
    const afterText = formatAiValue(after)
    if (beforeText === "—" && afterText === "—") return []
    return [{ field: "record", before: beforeText, after: afterText, changed: true }]
  }
  const beforeObj = isRecord(before) ? before : {}
  const afterObj = isRecord(after) ? after : {}
  const fields = [...new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)])].sort()
  return fields.map((field) => {
    const beforeText = formatAiValue(beforeObj[field])
    const afterText = formatAiValue(afterObj[field])
    return { field, before: beforeText, after: afterText, changed: beforeText !== afterText }
  })
}

/** One-line summary for a queue row. */
export function describeAiRequest(request: AiActionRequest): string {
  const verb = AI_ACTION_LABELS[request.action] ?? request.action
  const changed = aiDiffRows(request.before, request.after).filter((row) => row.changed)
  const target = request.recordId === null ? request.objectType : `${request.objectType}`
  if (changed.length === 0) return `${verb} ${target}`
  if (changed.length === 1 && changed[0] !== undefined) {
    return `${verb} ${target}: ${changed[0].field} → ${changed[0].after}`
  }
  return `${verb} ${target}: ${changed.length} fields`
}

/** Who proposed it, in words a reviewer can act on. */
export function describeAiProposer(request: AiActionRequest): string {
  const who = request.actorType === "agent" ? (request.agentId ?? "an AI agent") : "a person"
  return request.model === null ? who : `${who} · ${request.model}`
}

export function formatAiTimestamp(value: string | null): string {
  return value === null ? "—" : new Date(value).toLocaleString()
}

/** Only a pending request can be decided; only an applied one undone. */
export function canDecide(request: AiActionRequest): boolean {
  return request.status === "pending"
}

export function canRevert(request: AiActionRequest): boolean {
  return request.status === "applied"
}
