import { describe, expect, test } from "bun:test"
import { PermissionDeniedError } from "@yourcrm/permissions"
import {
  assertAiActionAllowed,
  assertAiActorResolved,
  assertHumanApprover,
  assertNotSelfApproval,
  aiActionPermission,
  AiSelfApprovalError,
  AI_ACTION_PERMISSIONS,
  AI_ACTION_OBJECT,
} from "./access"
import { AI_ACTION_TYPES } from "./schemas"

const WS = "ws"

function actor(actorId: string, role: string) {
  return { workspaceId: WS, actorId, role }
}

const TARGET = { objectType: "person", recordId: "p1", action: "update" as const }

describe("ai-governance/access", () => {
  test("every AI action maps onto a shared permission action", () => {
    for (const action of AI_ACTION_TYPES) {
      expect(AI_ACTION_PERMISSIONS[action]).toBeDefined()
    }
    // No AI-specific permission model: an AI update is a `person:update`.
    expect(aiActionPermission(actor("u", "member"), TARGET)).toEqual({
      workspaceId: WS,
      actorId: "u",
      role: "member",
      object: "person",
      action: "update",
      recordId: "p1",
    })
  })

  test("the intersection denies as soon as ONE actor cannot do it", () => {
    expect(() =>
      assertAiActionAllowed([actor("a", "owner"), actor("b", "member")], TARGET),
    ).not.toThrow()
    expect(() =>
      assertAiActionAllowed([actor("a", "owner"), actor("b", "viewer")], TARGET),
    ).toThrow(PermissionDeniedError)
    expect(() =>
      assertAiActionAllowed([actor("a", "viewer"), actor("b", "owner")], TARGET),
    ).toThrow(PermissionDeniedError)
  })

  test("an unresolved actor is refused rather than defaulted to a role", () => {
    expect(() => assertAiActorResolved(WS, "u", null, "requester")).toThrow(PermissionDeniedError)
    expect(() => assertAiActorResolved(WS, "", "owner", "approver")).toThrow(PermissionDeniedError)
    expect(() => assertAiActorResolved(WS, "u", "viewer", "requester")).not.toThrow()
  })

  test("self-approval is refused; approving somebody else's request is not", () => {
    expect(() => assertNotSelfApproval("u1", "u1")).toThrow(AiSelfApprovalError)
    expect(() => assertNotSelfApproval("u1", "u2")).not.toThrow()
  })

  test("only a human may decide", () => {
    expect(() => assertHumanApprover({ workspaceId: WS, actorId: "u" })).not.toThrow()
    expect(() =>
      assertHumanApprover({ workspaceId: WS, actorId: "u", actorType: "user" }),
    ).not.toThrow()
    expect(() =>
      assertHumanApprover({ workspaceId: WS, actorId: "bot", actorType: "agent" }),
    ).toThrow(AiSelfApprovalError)
  })

  test("the governed object name is stable — audit queries depend on it", () => {
    expect(AI_ACTION_OBJECT).toBe("ai_action_request")
  })
})
