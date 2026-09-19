import { describe, expect, test } from "bun:test"
import {
  CALL_STATUSES,
  decideCallStatusTransition,
  isCallStatus,
  isTerminalCallStatus,
  TERMINAL_CALL_STATUSES,
  type CallStatus,
} from "./status"

describe("calling/status", () => {
  test("isCallStatus / isTerminalCallStatus recognise the full status set", () => {
    for (const status of CALL_STATUSES) expect(isCallStatus(status)).toBe(true)
    expect(isCallStatus("bogus")).toBe(false)
    for (const status of TERMINAL_CALL_STATUSES) expect(isTerminalCallStatus(status)).toBe(true)
    expect(isTerminalCallStatus("ringing")).toBe(false)
    expect(isTerminalCallStatus("queued")).toBe(false)
  })

  test("forward progression is applied: queued -> ringing -> in_progress -> completed", () => {
    expect(decideCallStatusTransition("queued", "ringing").applied).toBe(true)
    expect(decideCallStatusTransition("ringing", "in_progress").applied).toBe(true)
    expect(decideCallStatusTransition("in_progress", "completed").applied).toBe(true)
  })

  test("a call can skip straight to a terminal status (e.g. immediate failure)", () => {
    expect(decideCallStatusTransition("queued", "failed").applied).toBe(true)
    expect(decideCallStatusTransition("queued", "no_answer").applied).toBe(true)
  })

  test("THE key invariant: a late/out-of-order ringing after completed must not regress the call", () => {
    const decision = decideCallStatusTransition("completed", "ringing")
    expect(decision.applied).toBe(false)
    expect(decision.reason).toContain("terminal")
  })

  test("once terminal, no further status is ever applied — including a different terminal one", () => {
    for (const terminal of TERMINAL_CALL_STATUSES) {
      for (const next of CALL_STATUSES) {
        expect(decideCallStatusTransition(terminal, next).applied).toBe(false)
      }
    }
  })

  test("a same-rank repeat is a harmless no-op (idempotent), not a regression", () => {
    // Same status recurring (e.g. a retried "ringing" delivery) is allowed to
    // re-apply — it is a no-op at the data level, and callers should not
    // treat it as a regression.
    expect(decideCallStatusTransition("ringing", "ringing").applied).toBe(true)
    expect(decideCallStatusTransition("queued", "queued").applied).toBe(true)
  })

  test("cannot regress from in_progress back to ringing or queued", () => {
    expect(decideCallStatusTransition("in_progress", "ringing").applied).toBe(false)
    expect(decideCallStatusTransition("in_progress", "queued").applied).toBe(false)
  })

  test("cannot regress from ringing back to queued", () => {
    expect(decideCallStatusTransition("ringing", "queued").applied).toBe(false)
  })

  test("exhaustive matrix: applied iff current is non-terminal and rank(next) >= rank(current)", () => {
    const rank: Record<CallStatus, number> = {
      queued: 0,
      ringing: 1,
      in_progress: 2,
      completed: 3,
      failed: 3,
      no_answer: 3,
      busy: 3,
    }
    for (const current of CALL_STATUSES) {
      for (const next of CALL_STATUSES) {
        const expected = !isTerminalCallStatus(current) && rank[next] >= rank[current]
        expect(decideCallStatusTransition(current, next).applied).toBe(expected)
      }
    }
  })
})
