/**
 * Call-status transition guard (spec 17-calling, P0).
 *
 * `CallStatus` here is a STRUCTURAL MIRROR of the same union in
 * `packages/database/src/schema/calling.ts` — `@yourcrm/crm` has no database
 * dependency (see `AGENTS.md`), so services never import `@yourcrm/database`.
 * Keep the two lists in sync; a mismatch is caught immediately by the
 * repository/route layer's `isCallStatus()` validation at the boundary.
 *
 * Click-to-call status advances via a provider webhook that can arrive
 * out of order or be re-delivered (the integrations framework dedupes on
 * provider event id, but that only stops the SAME event twice — a
 * `ringing` event and a later `completed` event are two different events,
 * and network jitter can deliver `ringing` after `completed`). This module
 * is the single place that decides whether an incoming status is allowed to
 * overwrite the one already stored, so the rule is defined once and unit
 * tested exhaustively rather than re-derived at each call site.
 *
 * Rule:
 *  1. Once a call reaches a TERMINAL status (`completed`, `failed`,
 *     `no_answer`, `busy`) it is sticky — no further status transition is
 *     applied, regardless of what arrives later or how many times.
 *  2. Before that, a transition is applied only if the incoming status's
 *     rank is >= the current status's rank (`queued` < `ringing` <
 *     `in_progress` < any terminal status). A same-rank repeat (e.g. two
 *     `ringing` events) is a harmless idempotent no-op.
 */

export const CALL_STATUSES = [
  "queued",
  "ringing",
  "in_progress",
  "completed",
  "failed",
  "no_answer",
  "busy",
] as const

export type CallStatus = (typeof CALL_STATUSES)[number]

export function isCallStatus(value: unknown): value is CallStatus {
  return typeof value === "string" && (CALL_STATUSES as readonly string[]).includes(value)
}

export const TERMINAL_CALL_STATUSES: readonly CallStatus[] = [
  "completed",
  "failed",
  "no_answer",
  "busy",
]

const CALL_STATUS_RANK: Record<CallStatus, number> = {
  queued: 0,
  ringing: 1,
  in_progress: 2,
  completed: 3,
  failed: 3,
  no_answer: 3,
  busy: 3,
}

export function isTerminalCallStatus(status: CallStatus): boolean {
  return (TERMINAL_CALL_STATUSES as readonly string[]).includes(status)
}

export type CallStatusTransitionDecision = {
  /** Whether `next` should be written over `current`. */
  applied: boolean
  /** Human-readable reason, useful for logs/audit when a transition is rejected. */
  reason: string
}

/** Pure decision function — no I/O, exhaustively unit tested. */
export function decideCallStatusTransition(
  current: CallStatus,
  next: CallStatus,
): CallStatusTransitionDecision {
  if (isTerminalCallStatus(current)) {
    return {
      applied: false,
      reason: `call is already terminal (${current}); ignoring out-of-order/late "${next}"`,
    }
  }
  if (CALL_STATUS_RANK[next] < CALL_STATUS_RANK[current]) {
    return {
      applied: false,
      reason: `"${next}" would regress "${current}"; ignoring out-of-order update`,
    }
  }
  return { applied: true, reason: `"${current}" -> "${next}"` }
}
