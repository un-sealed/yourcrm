import { describe, expect, test } from "bun:test"
import {
  aiDiffRows,
  canDecide,
  canRevert,
  describeAiProposer,
  describeAiRequest,
  formatAiValue,
  type AiActionRequest,
} from "./types"

function makeRequest(overrides: Partial<AiActionRequest> = {}): AiActionRequest {
  return {
    id: "airq_1",
    workspaceId: "ws",
    actorType: "agent",
    actorId: "user_1",
    agentId: "data-hygiene",
    model: "claude-sonnet-4-6",
    runId: "run_1",
    correlationId: null,
    objectType: "person",
    recordId: "person_1",
    action: "update",
    before: { title: "CEO" },
    after: { title: "CTO" },
    rationale: "Signature says CTO.",
    status: "pending",
    policyMode: "require_approval",
    requestedRole: "member",
    expiresAt: null,
    decidedAt: null,
    appliedAt: null,
    applyError: null,
    revertedAt: null,
    createdAt: "2026-09-19T10:00:00.000Z",
    updatedAt: "2026-09-19T10:00:00.000Z",
    ...overrides,
  }
}

describe("ai governance/diff", () => {
  test("a changed field is marked changed", () => {
    expect(aiDiffRows({ title: "CEO" }, { title: "CTO" })).toEqual([
      { field: "title", before: "CEO", after: "CTO", changed: true },
    ])
  })

  test("a removed field is shown, not hidden", () => {
    const rows = aiDiffRows({ title: "CEO", notes: "keep" }, { title: "CTO" })
    expect(rows.map((r) => r.field)).toEqual(["notes", "title"])
    expect(rows.find((r) => r.field === "notes")).toEqual({
      field: "notes",
      before: "keep",
      after: "—",
      changed: true,
    })
  })

  test("unchanged fields are listed but not flagged", () => {
    const rows = aiDiffRows({ title: "CEO", city: "Berlin" }, { title: "CTO", city: "Berlin" })
    expect(rows.filter((r) => r.changed).map((r) => r.field)).toEqual(["title"])
  })

  test("a whole-record create or delete becomes one honest row", () => {
    expect(aiDiffRows(null, "a new person")).toEqual([
      { field: "record", before: "—", after: "a new person", changed: true },
    ])
    expect(aiDiffRows(null, null)).toEqual([])
  })

  test("values render without leaking JSON noise for scalars", () => {
    expect(formatAiValue("x")).toBe("x")
    expect(formatAiValue(3)).toBe("3")
    expect(formatAiValue(false)).toBe("false")
    expect(formatAiValue(null)).toBe("—")
    expect(formatAiValue({ a: 1 })).toBe('{"a":1}')
  })
})

describe("ai governance/summaries", () => {
  test("a single-field change reads as a sentence", () => {
    expect(describeAiRequest(makeRequest())).toBe("Update person: title → CTO")
  })

  test("several changes are counted rather than listed", () => {
    const request = makeRequest({
      before: { title: "CEO", city: "Berlin" },
      after: { title: "CTO", city: "Munich" },
    })
    expect(describeAiRequest(request)).toBe("Update person: 2 fields")
  })

  test("the proposer names the agent and the model", () => {
    expect(describeAiProposer(makeRequest())).toBe("data-hygiene · claude-sonnet-4-6")
    expect(describeAiProposer(makeRequest({ actorType: "user", agentId: null, model: null }))).toBe(
      "a person",
    )
  })

  test("only a pending request can be decided, only an applied one undone", () => {
    expect(canDecide(makeRequest())).toBe(true)
    expect(canDecide(makeRequest({ status: "applied" }))).toBe(false)
    expect(canRevert(makeRequest({ status: "applied" }))).toBe(true)
    expect(canRevert(makeRequest({ status: "pending" }))).toBe(false)
  })
})
