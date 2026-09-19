import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import type { AiActionApproval, AiActionRequest, AiPolicy } from "../schema/ai-governance"
import {
  createAiGovernanceRepository,
  normalizeAiObjectType,
  validateAiActionStatus,
  validateAiActionType,
  validateAiPolicyMode,
  AiGovernanceDefinitionError,
} from "./ai-governance-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const APPROVAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const MIGRATION = new URL("../../migrations/0350_ai_governance.sql", import.meta.url)

/** Thenable chain stub: every builder call returns the proxy; each await pops one result. */
function mockDb(queued: unknown[][] = []) {
  let step = 0
  const proxy = new Proxy(function () {}, {
    get(_target, prop: string | symbol) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void) => {
          resolve(queued[step] ?? [])
          step += 1
        }
      }
      return (..._args: unknown[]) => proxy
    },
  })
  return proxy as unknown as Database
}

function makeRequest(overrides: Partial<AiActionRequest> = {}): AiActionRequest {
  return {
    id: REQUEST_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    actorType: "agent",
    actorId: "22222222-2222-4222-8222-222222222222",
    agentId: null,
    model: null,
    runId: null,
    correlationId: null,
    objectType: "person",
    recordId: "person-1",
    action: "update",
    before: null,
    after: null,
    rationale: null,
    status: "pending",
    policyId: null,
    policyMode: "require_approval",
    requestedRole: null,
    expiresAt: null,
    decidedAt: null,
    applyClaimedAt: null,
    applyClaimedBy: null,
    appliedAt: null,
    applyResult: null,
    applyError: null,
    revertClaimedAt: null,
    revertClaimedBy: null,
    revertedAt: null,
    revertError: null,
    ...overrides,
  }
}

function makeApproval(overrides: Partial<AiActionApproval> = {}): AiActionApproval {
  return {
    id: APPROVAL_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    requestId: REQUEST_ID,
    decision: "approved",
    approverId: "33333333-3333-4333-8333-333333333333",
    approverRole: "owner",
    requesterRole: "member",
    reason: null,
    correlationId: null,
    ...overrides,
  }
}

function makePolicy(overrides: Partial<AiPolicy> = {}): AiPolicy {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    objectType: "*",
    action: "*",
    mode: "require_approval",
    description: null,
    enabled: true,
    ...overrides,
  }
}

describe("database/ai-governance-repository", () => {
  const repository = createAiGovernanceRepository()

  describe("validation", () => {
    test("object types are normalised, and a request may not use the wildcard", () => {
      expect(normalizeAiObjectType(" Person ")).toBe("person")
      expect(normalizeAiObjectType("*", true)).toBe("*")
      expect(() => normalizeAiObjectType("*")).toThrow(AiGovernanceDefinitionError)
      expect(() => normalizeAiObjectType("drop table")).toThrow(AiGovernanceDefinitionError)
    })

    test("unknown actions, statuses and modes never reach SQL", () => {
      expect(validateAiActionType("update")).toBe("update")
      expect(validateAiActionType("*", true)).toBe("*")
      expect(() => validateAiActionType("exfiltrate")).toThrow(AiGovernanceDefinitionError)
      expect(validateAiActionStatus("applied")).toBe("applied")
      expect(() => validateAiActionStatus("done")).toThrow(AiGovernanceDefinitionError)
      expect(validateAiPolicyMode("auto_apply")).toBe("auto_apply")
      expect(() => validateAiPolicyMode("whatever")).toThrow(AiGovernanceDefinitionError)
    })
  })

  describe("one decision per request", () => {
    test("an insert that wins reports created: true", async () => {
      const db = mockDb([[makeApproval()]])
      const result = await repository.recordDecision(db, WS, {
        requestId: REQUEST_ID,
        decision: "approved",
        approverId: "33333333-3333-4333-8333-333333333333",
      })
      expect(result.created).toBe(true)
    })

    test("a conflict returns the existing decision with created: false", async () => {
      // First await: the ON CONFLICT DO NOTHING insert returns nothing.
      // Second await: the select finds the decision already recorded.
      const db = mockDb([[], [makeApproval({ decision: "rejected" })]])
      const result = await repository.recordDecision(db, WS, {
        requestId: REQUEST_ID,
        decision: "approved",
        approverId: "55555555-5555-4555-8555-555555555555",
      })
      expect(result.created).toBe(false)
      expect(result.approval.decision).toBe("rejected")
    })

    test("an unknown decision is refused before it reaches SQL", async () => {
      const db = mockDb([[makeApproval()]])
      await expect(
        repository.recordDecision(db, WS, {
          requestId: REQUEST_ID,
          decision: "maybe",
          approverId: "33333333-3333-4333-8333-333333333333",
        }),
      ).rejects.toThrow(AiGovernanceDefinitionError)
    })
  })

  describe("claim before apply", () => {
    test("winning the conditional UPDATE claims the request", async () => {
      const db = mockDb([[makeRequest({ status: "approved", applyClaimedAt: new Date() })]])
      const result = await repository.claimRequestApply(db, WS, REQUEST_ID, {
        claimedBy: "33333333-3333-4333-8333-333333333333",
        claimedAt: new Date(),
      })
      expect(result.claimed).toBe(true)
    })

    test("an UPDATE that matches nothing reports claimed: false and the current row", async () => {
      // First await: the claim matched no row. Second: the row as it stands.
      const db = mockDb([[], [makeRequest({ status: "applied" })]])
      const result = await repository.claimRequestApply(db, WS, REQUEST_ID, {
        claimedBy: "33333333-3333-4333-8333-333333333333",
        claimedAt: new Date(),
      })
      expect(result.claimed).toBe(false)
      expect(result.request?.status).toBe("applied")
    })

    test("revert claims the same way", async () => {
      const db = mockDb([[], [makeRequest({ status: "reverted" })]])
      const result = await repository.claimRequestRevert(db, WS, REQUEST_ID, {
        claimedBy: "33333333-3333-4333-8333-333333333333",
        claimedAt: new Date(),
      })
      expect(result.claimed).toBe(false)
    })
  })

  describe("queries", () => {
    test("search rejects an unknown status rather than filtering on it", async () => {
      await expect(
        repository.searchRequests(mockDb([[]]), { workspaceId: WS, status: "whatever" }),
      ).rejects.toThrow(AiGovernanceDefinitionError)
    })

    test("search returns the cursor pagination envelope", async () => {
      const db = mockDb([[makeRequest()]])
      const result = await repository.searchRequests(db, { workspaceId: WS, limit: 25 })
      expect(result.data).toHaveLength(1)
      expect(result.pagination).toEqual({ nextCursor: null, limit: 25 })
    })

    test("policy creation defaults to the whole workspace, requiring approval", async () => {
      const db = mockDb([[makePolicy()]])
      const policy = await repository.createPolicy(db, WS, {})
      expect(policy.mode).toBe("require_approval")
    })
  })

  describe("migration 0350", () => {
    test("one decision per request is a UNIQUE index, not a convention", async () => {
      const sql = await readFile(MIGRATION, "utf8")
      expect(sql).toContain(
        "CREATE UNIQUE INDEX IF NOT EXISTS ai_action_approvals_request_idx\n  ON ai_action_approvals (request_id)",
      )
    })

    test("the claim columns exist on the request, not on a side table", async () => {
      const sql = await readFile(MIGRATION, "utf8")
      expect(sql).toContain("apply_claimed_at TIMESTAMPTZ")
      expect(sql).toContain("revert_claimed_at TIMESTAMPTZ")
    })

    test("policy scopes are unique per workspace while they are live", async () => {
      const sql = await readFile(MIGRATION, "utf8")
      expect(sql).toContain("ai_policies_scope_idx")
      expect(sql).toContain("WHERE deleted_at IS NULL")
    })

    test("the default mode in the schema is require_approval", async () => {
      const sql = await readFile(MIGRATION, "utf8")
      expect(sql).toContain("mode VARCHAR(32) NOT NULL DEFAULT 'require_approval'")
      expect(sql).not.toContain("DEFAULT 'auto_apply'")
    })

    test("the target is polymorphic: no foreign key to another module's tables", async () => {
      const sql = await readFile(MIGRATION, "utf8")
      const references = [...sql.matchAll(/REFERENCES\s+(\w+)/g)].map((m) => m[1])
      expect(new Set(references)).toEqual(new Set(["ai_policies", "ai_action_requests"]))
      expect(sql).not.toContain("REFERENCES people")
      expect(sql).not.toContain("REFERENCES users")
    })
  })
})
