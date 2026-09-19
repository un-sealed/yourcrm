import type { BadgeTone } from "@yourcrm/ui"

/**
 * Sales sequences API shapes and presentation helpers (spec 47, P0).
 *
 * The UI is a thin view over `/api/v1/sequences`. Every rule it appears to
 * enforce — a draft cannot enrol, a viewer cannot activate, a replied-to
 * prospect gets no more mail — is enforced server-side; the affordances
 * here only avoid asking for something the server will refuse.
 *
 * KNOWN GAP (reported, not worked around): enrolling somebody needs a
 * person picker, and the API exposes no people-search endpoint shaped for
 * a combobox. The enrol form therefore takes a person id, and the page
 * links to `/app/people` to find one. See `docs` note in the report.
 */

export const SEQUENCE_STATUSES = ["draft", "active", "paused", "archived"] as const

export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number]

export const SEQUENCE_STEP_TYPES = ["email", "task", "wait"] as const

export type SequenceStepType = (typeof SEQUENCE_STEP_TYPES)[number]

export type SequenceStep = {
  id: string
  sequenceId: string
  stepIndex: number
  stepType: SequenceStepType
  name: string | null
  waitDays: number
  waitHours: number
  config: Record<string, unknown>
}

export type Sequence = {
  id: string
  workspaceId: string
  name: string
  description: string | null
  status: SequenceStatus
  ownerId: string | null
  exitOnReply: boolean
  exitOnBounce: boolean
  lastEnrolledAt: string | null
  createdAt: string
  updatedAt: string
}

export type SequenceDetail = Sequence & { steps: SequenceStep[] }

export type SequenceEnrollment = {
  id: string
  sequenceId: string
  personId: string
  dealId: string | null
  emailAddress: string
  threadId: string | null
  status: string
  exitReason: string | null
  currentStepIndex: number
  nextRunAt: string | null
  sentCount: number
  error: string | null
  startedAt: string | null
  completedAt: string | null
  stoppedAt: string | null
}

export type SequenceStepRun = {
  id: string
  stepIndex: number
  stepType: string
  status: string
  error: string | null
  finishedAt: string | null
}

export type SequenceEnrollmentDetail = SequenceEnrollment & { runs: SequenceStepRun[] }

export type SequenceListResponse = {
  data: Sequence[]
  pagination: { nextCursor: string | null; limit: number }
}

export type SequenceEnrollmentListResponse = {
  data: SequenceEnrollment[]
  pagination: { nextCursor: string | null; limit: number }
}

export type SequenceStats = {
  enrollments: { status: string; exitReason: string | null; count: number }[]
  steps: { stepIndex: number; stepType: string; status: string; count: number }[]
}

export type SequenceCatalogue = {
  stepTypes: { type: string; label: string }[]
  exitReasons: { reason: string; label: string; automatic: boolean }[]
  maxSteps: number
  maxWaitDays: number
  maxWaitHours: number
}

/* ------------------------------ presentation ------------------------------ */

export const SEQUENCE_STATUS_LABELS: Record<SequenceStatus, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  archived: "Archived",
}

/** Tone is colour PLUS the status word — never colour alone (a11y). */
export function sequenceStatusTone(status: string): BadgeTone {
  switch (status) {
    case "active":
      return "success"
    case "paused":
      return "warning"
    case "archived":
      return "secondary"
    default:
      return "outline"
  }
}

/**
 * Enrollment tone. A `stopped` drip is not a failure — usually it means
 * the prospect replied, which is the outcome everybody wanted — so it
 * reads neutral, not destructive.
 */
export function enrollmentStatusTone(status: string): BadgeTone {
  switch (status) {
    case "active":
      return "success"
    case "paused":
      return "warning"
    case "completed":
      return "info"
    case "failed":
      return "destructive"
    default:
      return "secondary"
  }
}

export const EXIT_REASON_LABELS: Record<string, string> = {
  replied: "Replied",
  bounced: "Bounced",
  unsubscribed: "Unsubscribed",
  removed: "Removed by hand",
  sequence_archived: "Sequence archived",
  completed: "Finished every step",
  failed: "Failed",
}

export function exitReasonLabel(reason: string | null): string {
  if (reason === null || reason === "") return "—"
  return EXIT_REASON_LABELS[reason] ?? reason
}

/** Human summary of a step, used in the list and the editor preview. */
export function describeSequenceStep(step: {
  stepType: string
  name?: string | null
  waitDays?: number | null
  waitHours?: number | null
  config?: Record<string, unknown> | null
}): string {
  const named = typeof step.name === "string" && step.name.trim() !== "" ? step.name.trim() : null
  if (named !== null) return named
  const config = step.config ?? {}
  switch (step.stepType) {
    case "email": {
      const subject = typeof config.subject === "string" ? config.subject : ""
      return subject === "" ? "Email" : `Email — ${subject}`
    }
    case "task": {
      const title = typeof config.title === "string" ? config.title : ""
      return title === "" ? "Task" : `Task — ${title}`
    }
    case "wait":
      return `Wait ${formatDelay(step.waitDays ?? 0, step.waitHours ?? 0)}`
    default:
      return step.stepType
  }
}

/** "3 days", "4 hours", "1 day 2 hours", or "immediately". */
export function formatDelay(days: number, hours: number): string {
  const parts: string[] = []
  if (days > 0) parts.push(`${days} ${days === 1 ? "day" : "days"}`)
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`)
  return parts.length === 0 ? "immediately" : parts.join(" ")
}

export function formatSequenceTimestamp(value: string | null): string {
  if (!value) return "—"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return "—"
  return parsed.toLocaleString()
}

/**
 * Which status buttons to offer. Mirrors the server's rules so the UI does
 * not invite a 403 or a 422 — it never replaces them.
 */
export function nextSequenceStatuses(sequence: Pick<Sequence, "status">): SequenceStatus[] {
  switch (sequence.status) {
    case "draft":
      return ["active", "archived"]
    case "active":
      return ["paused", "archived"]
    case "paused":
      return ["active", "archived"]
    case "archived":
      return ["draft"]
    default:
      return []
  }
}

/** Flatten the stats envelope into the two numbers a header can show. */
export function summarizeSequenceStats(stats: SequenceStats | null): {
  enrolled: number
  active: number
  stopped: number
  sent: number
} {
  if (stats === null) return { enrolled: 0, active: 0, stopped: 0, sent: 0 }
  let enrolled = 0
  let active = 0
  let stopped = 0
  for (const row of stats.enrollments) {
    enrolled += row.count
    if (row.status === "active") active += row.count
    if (row.status === "stopped") stopped += row.count
  }
  const sent = stats.steps
    .filter((row) => row.stepType === "email" && row.status === "succeeded")
    .reduce((total, row) => total + row.count, 0)
  return { enrolled, active, stopped, sent }
}

/** Query-string builder for the sequence list. */
export type SequenceFilters = {
  query: string
  status: "" | SequenceStatus
}

export const DEFAULT_SEQUENCE_FILTERS: SequenceFilters = { query: "", status: "" }

export function sequenceQueryString(
  filters: SequenceFilters,
  cursor: string | null,
  limit = 25,
): string {
  const params = new URLSearchParams({ limit: String(limit) })
  if (filters.query.trim() !== "") params.set("query", filters.query.trim())
  if (filters.status !== "") params.set("status", filters.status)
  if (cursor) params.set("cursor", cursor)
  return params.toString()
}
