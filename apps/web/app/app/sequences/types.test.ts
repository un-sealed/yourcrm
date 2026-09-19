import { describe, expect, test } from "bun:test"
import {
  DEFAULT_SEQUENCE_FILTERS,
  describeSequenceStep,
  enrollmentStatusTone,
  exitReasonLabel,
  formatDelay,
  formatSequenceTimestamp,
  nextSequenceStatuses,
  sequenceQueryString,
  sequenceStatusTone,
  summarizeSequenceStats,
  SEQUENCE_STATUSES,
  SEQUENCE_STEP_TYPES,
} from "./types"

describe("sequences/presentation", () => {
  test("the UI vocabulary matches the P0 server vocabulary", () => {
    expect([...SEQUENCE_STATUSES]).toEqual(["draft", "active", "paused", "archived"])
    expect([...SEQUENCE_STEP_TYPES]).toEqual(["email", "task", "wait"])
  })

  test("every status has a tone, and none of them is colour-only", () => {
    for (const status of SEQUENCE_STATUSES) {
      expect(typeof sequenceStatusTone(status)).toBe("string")
    }
    expect(sequenceStatusTone("unknown")).toBe("outline")
  })

  /**
   * A stopped drip usually means the prospect replied — the outcome the
   * whole module exists to produce. It must not read as an error.
   */
  test("a stopped enrollment does not read as a failure", () => {
    expect(enrollmentStatusTone("stopped")).toBe("secondary")
    expect(enrollmentStatusTone("failed")).toBe("destructive")
    expect(enrollmentStatusTone("active")).toBe("success")
  })

  test("exit reasons are humanised, unknown ones pass through", () => {
    expect(exitReasonLabel("replied")).toBe("Replied")
    expect(exitReasonLabel("sequence_archived")).toBe("Sequence archived")
    expect(exitReasonLabel(null)).toBe("—")
    expect(exitReasonLabel("weird")).toBe("weird")
  })

  test("delays read in plain words", () => {
    expect(formatDelay(0, 0)).toBe("immediately")
    expect(formatDelay(1, 0)).toBe("1 day")
    expect(formatDelay(3, 0)).toBe("3 days")
    expect(formatDelay(0, 1)).toBe("1 hour")
    expect(formatDelay(1, 2)).toBe("1 day 2 hours")
  })

  test("a step describes itself from its own config", () => {
    expect(describeSequenceStep({ stepType: "email", config: { subject: "Hi" } })).toBe(
      "Email — Hi",
    )
    expect(describeSequenceStep({ stepType: "email", config: {} })).toBe("Email")
    expect(describeSequenceStep({ stepType: "task", config: { title: "Call" } })).toBe(
      "Task — Call",
    )
    expect(describeSequenceStep({ stepType: "wait", waitDays: 2 })).toBe("Wait 2 days")
    expect(describeSequenceStep({ stepType: "email", name: "  Opener  ", config: {} })).toBe(
      "Opener",
    )
  })

  test("timestamps degrade to an em dash rather than Invalid Date", () => {
    expect(formatSequenceTimestamp(null)).toBe("—")
    expect(formatSequenceTimestamp("not-a-date")).toBe("—")
    expect(formatSequenceTimestamp("2026-03-01T10:00:00Z")).not.toBe("—")
  })

  /**
   * The affordances must mirror the server's rules, or the UI invites
   * 403s and 422s. Pausing is always offered next to activating, because
   * stopping a running sequence must never be harder than starting it.
   */
  test("status transitions mirror the server's rules", () => {
    expect(nextSequenceStatuses({ status: "draft" })).toEqual(["active", "archived"])
    expect(nextSequenceStatuses({ status: "active" })).toEqual(["paused", "archived"])
    expect(nextSequenceStatuses({ status: "paused" })).toEqual(["active", "archived"])
    expect(nextSequenceStatuses({ status: "archived" })).toEqual(["draft"])
  })

  test("stats summarise into the counters a header can show", () => {
    expect(summarizeSequenceStats(null)).toEqual({ enrolled: 0, active: 0, stopped: 0, sent: 0 })
    expect(
      summarizeSequenceStats({
        enrollments: [
          { status: "active", exitReason: null, count: 3 },
          { status: "stopped", exitReason: "replied", count: 2 },
          { status: "completed", exitReason: "completed", count: 1 },
        ],
        steps: [
          { stepIndex: 0, stepType: "email", status: "succeeded", count: 6 },
          { stepIndex: 0, stepType: "email", status: "failed", count: 1 },
          { stepIndex: 1, stepType: "wait", status: "succeeded", count: 4 },
        ],
      }),
    ).toEqual({ enrolled: 6, active: 3, stopped: 2, sent: 6 })
  })

  test("the list query string only sends the filters that are set", () => {
    expect(sequenceQueryString(DEFAULT_SEQUENCE_FILTERS, null)).toBe("limit=25")
    expect(sequenceQueryString({ query: "  outbound ", status: "active" }, "cur_1")).toBe(
      "limit=25&query=outbound&status=active&cursor=cur_1",
    )
  })
})
