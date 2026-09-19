import { describe, expect, test } from "bun:test"
import type { Session, WorkspaceRole } from "@yourcrm/auth"
import type { McpSession } from "./auth"
import { createDevMcpRuntime, DEV_WORKSPACE_ID } from "./dev-runtime"
import { createMcpToolset } from "./tools"

/**
 * PROPERTY 2 — an MCP write does not write.
 *
 * These tests run the REAL `createAiGovernanceService` (see
 * `dev-runtime.ts`): only the store underneath it is in memory. So what is
 * asserted here is the actual governance behaviour, not a stub's:
 * `requestAction` queues an `ai_action_request` with status `pending` and
 * returns, the applier is never reached, and the fixture records are
 * byte-identical afterwards.
 *
 * The apply seam is welded shut on both sides: the runtime types
 * `governance` as `AiActionProposalPort` (one method, `requestAction`), and
 * the dev applier throws and counts. There is no path from a tool call to
 * a record.
 */

function callerFor(actorId: string, role: WorkspaceRole): McpSession {
  const session: Session = {
    user: { id: actorId, email: `${actorId}@yourcrm.test` },
    memberships: [{ workspaceId: DEV_WORKSPACE_ID, role }],
    workspaceId: DEV_WORKSPACE_ID,
  }
  return { session, correlationId: `corr_${actorId}`, clientId: "claude-desktop" }
}

function setup() {
  const dev = createDevMcpRuntime()
  return { dev, toolset: createMcpToolset(dev.runtime), before: JSON.stringify(dev.dataset) }
}

type ProposalResult = {
  request: Record<string, unknown>
  policyMode: string
  applied: boolean
  note: string
}

describe("mcp/governed-writes", () => {
  test("propose_create_task queues a pending request and changes nothing", async () => {
    const { dev, toolset, before } = setup()
    const outcome = await toolset.call(
      "yourcrm_propose_create_task",
      { title: "Send the signed order form", priority: "high", rationale: "Ada asked on the call" },
      callerFor("user_member", "member"),
    )
    const result = outcome.result as ProposalResult

    expect(result.request.status).toBe("pending")
    expect(result.policyMode).toBe("require_approval")
    expect(result.applied).toBe(false)
    expect(result.note).toContain("Nothing has changed yet")

    // One queued proposal...
    expect(dev.requests).toHaveLength(1)
    expect(dev.requests[0]).toMatchObject({
      workspaceId: DEV_WORKSPACE_ID,
      objectType: "task",
      action: "create",
      status: "pending",
      // The permissions are the human's; the actor TYPE is the machine's,
      // which is what stops it approving anything.
      actorId: "user_member",
      actorType: "agent",
      agentId: "claude-desktop",
      requestedRole: "member",
    })
    expect(dev.requests[0]?.after).toEqual({
      title: "Send the signed order form",
      assigneeId: "user_member",
      priority: "high",
    })

    // ...and not one changed record.
    expect(JSON.stringify(dev.dataset)).toBe(before)
    expect(dev.applyAttempts()).toBe(0)
  })

  test("propose_update_record records before and after, and still writes nothing", async () => {
    const { dev, toolset, before } = setup()
    const outcome = await toolset.call(
      "yourcrm_propose_update_record",
      {
        objectType: "deal",
        recordId: "deal_1",
        before: { stage: "proposal" },
        after: { stage: "negotiation" },
        rationale: "They verbally agreed the scope",
      },
      callerFor("user_member", "member"),
    )
    const result = outcome.result as ProposalResult
    expect(result.request.status).toBe("pending")
    expect(dev.requests[0]).toMatchObject({
      objectType: "deal",
      recordId: "deal_1",
      action: "update",
    })
    expect(dev.requests[0]?.before).toEqual({ stage: "proposal" })
    expect(dev.requests[0]?.after).toEqual({ stage: "negotiation" })

    // The deal itself is untouched — the whole point.
    expect(dev.dataset.deal?.find((row) => row.id === "deal_1")?.stage).toBe("proposal")
    expect(JSON.stringify(dev.dataset)).toBe(before)
    expect(dev.applyAttempts()).toBe(0)
  })

  test("propose_create_record refuses a proposal governance would not accept", async () => {
    const { dev, toolset } = setup()
    // `create` may not name a record — governance's own schema says so,
    // and MCP does not get to relax it.
    await expect(
      toolset.call(
        "yourcrm_propose_create_record",
        { objectType: "person", values: {}, rationale: "" },
        callerFor("user_member", "member"),
      ),
    ).rejects.toThrow()
    expect(dev.requests).toHaveLength(0)
  })

  test("the proposal is attributable: audit trail names actor, model surface and request", async () => {
    const { dev, toolset } = setup()
    await toolset.call(
      "yourcrm_propose_create_task",
      { title: "Follow up", rationale: "asked on the call" },
      callerFor("user_member", "member"),
    )
    const governanceRow = dev.auditLog.find((entry) => entry.object === "ai_action_request")
    expect(governanceRow).toMatchObject({ action: "request", source: "ai", actorId: "user_member" })
    const mcpRow = dev.auditLog.find((entry) => entry.object === "mcp_tool")
    expect(mcpRow).toMatchObject({ action: "tool_call", source: "mcp", actorId: "user_member" })
    expect(mcpRow?.after).toMatchObject({ outcome: "succeeded", access: "propose" })
  })

  test("a proposer whose membership cannot be resolved is refused, not defaulted", async () => {
    const { dev, toolset } = setup()
    // The session claims `member`; the workspace no longer knows them.
    // `resolveActorRole` returns null and governance refuses rather than
    // falling back to a role.
    await expect(
      toolset.call(
        "yourcrm_propose_create_task",
        { title: "x", rationale: "y" },
        callerFor("user_departed", "member"),
      ),
    ).rejects.toThrow()
    expect(dev.requests).toHaveLength(0)
    expect(dev.applyAttempts()).toBe(0)
  })
})
