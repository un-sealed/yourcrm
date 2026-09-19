import { describe, expect, test } from "bun:test"
import {
  aiPolicySpecificity,
  describeAiPolicyModes,
  resolveAiPolicy,
  AI_POLICY_DEFAULT_MODE,
} from "./policy"
import type { AiPolicyRecord } from "./types"

/**
 * Policy resolution is a pure function, so these tests need nothing but
 * the function. The property they exist to pin down is the DEFAULT: an
 * unconfigured workspace has a fully manual AI.
 */

function policy(partial: Partial<AiPolicyRecord>): AiPolicyRecord {
  return {
    id: partial.id ?? "p",
    workspaceId: "ws",
    objectType: partial.objectType ?? "*",
    action: partial.action ?? "*",
    mode: partial.mode ?? "require_approval",
    enabled: partial.enabled ?? true,
    ...partial,
  }
}

const SCOPE = { objectType: "person", action: "update" as const }

describe("ai-governance/policy", () => {
  test("the default is require_approval, never auto_apply", () => {
    expect(AI_POLICY_DEFAULT_MODE).toBe("require_approval")
    const resolution = resolveAiPolicy([], SCOPE)
    expect(resolution.mode).toBe("require_approval")
    expect(resolution.policyId).toBeNull()
    expect(resolution.scope).toBe("*:*")
  })

  test("the most specific matching policy wins", () => {
    const resolution = resolveAiPolicy(
      [
        policy({ id: "wide", mode: "auto_apply" }),
        policy({ id: "object", objectType: "person", mode: "forbidden" }),
        policy({ id: "exact", objectType: "person", action: "update", mode: "require_approval" }),
      ],
      SCOPE,
    )
    expect(resolution.policyId).toBe("exact")
    expect(resolution.scope).toBe("person:update")
  })

  test("a whole-object policy beats an action-wide one", () => {
    const resolution = resolveAiPolicy(
      [
        policy({ id: "action-wide", action: "update", mode: "auto_apply" }),
        policy({ id: "object-wide", objectType: "person", mode: "forbidden" }),
      ],
      SCOPE,
    )
    expect(resolution.policyId).toBe("object-wide")
    expect(resolution.mode).toBe("forbidden")
  })

  test("policies for other scopes are ignored", () => {
    const resolution = resolveAiPolicy(
      [policy({ objectType: "deal", action: "delete", mode: "auto_apply" })],
      SCOPE,
    )
    expect(resolution.mode).toBe("require_approval")
    expect(aiPolicySpecificity(policy({ objectType: "deal" }), SCOPE)).toBe(-1)
  })

  test("a disabled or soft-deleted policy cannot loosen the gate", () => {
    expect(
      resolveAiPolicy(
        [policy({ objectType: "person", action: "update", mode: "auto_apply", enabled: false })],
        SCOPE,
      ).mode,
    ).toBe("require_approval")
    expect(
      resolveAiPolicy(
        [
          policy({
            objectType: "person",
            action: "update",
            mode: "auto_apply",
            deletedAt: new Date(),
          }),
        ],
        SCOPE,
      ).mode,
    ).toBe("require_approval")
  })

  test("an unreadable mode falls back to requiring a human", () => {
    const resolution = resolveAiPolicy(
      [policy({ objectType: "person", action: "update", mode: "yolo" })],
      SCOPE,
    )
    expect(resolution.mode).toBe("require_approval")
    expect(resolution.policyId).toBeNull()
  })

  test("specificity ranks exact > object > action > wildcard", () => {
    expect(aiPolicySpecificity(policy({ objectType: "person", action: "update" }), SCOPE)).toBe(3)
    expect(aiPolicySpecificity(policy({ objectType: "person" }), SCOPE)).toBe(2)
    expect(aiPolicySpecificity(policy({ action: "update" }), SCOPE)).toBe(1)
    expect(aiPolicySpecificity(policy({}), SCOPE)).toBe(0)
  })

  test("every mode is explained for the settings UI", () => {
    expect(describeAiPolicyModes().map((m) => m.mode)).toEqual([
      "require_approval",
      "auto_apply",
      "forbidden",
    ])
  })
})
