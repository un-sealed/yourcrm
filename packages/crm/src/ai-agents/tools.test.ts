import { describe, expect, test } from "bun:test"
import { createAiToolRegistry, AiWriteToolNotAllowedError } from "../ai-assistant/tools"
import type { AiTool } from "../ai-assistant/types"
import type { AiActionProposalPort, AiGovernanceServiceContext } from "../ai-governance/types"
import {
  assertAiAgentToolAccess,
  createAiAgentProposalTool,
  createAiAgentToolRegistry,
  toAiAgentReadTool,
  AiAgentWriteToolNotAllowedError,
  AI_AGENT_TOOL_PROPOSE,
} from "./tools"
import type { AiAgentToolContext } from "./types"

/**
 * The tool layer is where "reads happen, writes are proposed" is either
 * true or decorative. These tests hold both gates shut.
 */

const ctx: AiAgentToolContext = {
  workspaceId: "ws-1",
  actorId: "user-1",
  role: "member",
  correlationId: "agentrun:run-1",
  agentId: "agent-1",
  runId: "run-1",
  model: "stub-echo-1",
}

function readTool(name: string): AiTool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    access: "read",
    execute: async () => ({ result: { ok: true }, summary: `${name} ran` }),
  }
}

/** A tool that would mutate. It must never be constructible into an agent. */
function writeTool(name: string): AiTool {
  return { ...readTool(name), access: "write" as unknown as "read" }
}

function recordingProposalPort(): {
  port: AiActionProposalPort
  calls: { ctx: AiGovernanceServiceContext; input: unknown }[]
} {
  const calls: { ctx: AiGovernanceServiceContext; input: unknown }[] = []
  return {
    calls,
    port: {
      requestAction: async (proposalCtx, input) => {
        calls.push({ ctx: proposalCtx, input })
        return {
          request: {
            id: "airq-1",
            workspaceId: proposalCtx.workspaceId,
            actorId: proposalCtx.actorId,
            objectType: "person",
            action: "update",
            status: "pending",
          },
          mode: "require_approval",
          applied: false,
        }
      },
    },
  }
}

describe("ai-agents/tool gate", () => {
  test("a write tool cannot be wrapped as an agent tool", () => {
    expect(() => toAiAgentReadTool(writeTool("crm_update_person"))).toThrow(
      AiAgentWriteToolNotAllowedError,
    )
  })

  test("a write tool cannot even reach the registry: the assistant refuses it first", () => {
    expect(() => createAiToolRegistry([writeTool("crm_update_person")])).toThrow(
      AiWriteToolNotAllowedError,
    )
  })

  test("only `read` and `propose` are admissible", () => {
    expect(() => assertAiAgentToolAccess({ name: "x", access: "read" })).not.toThrow()
    expect(() => assertAiAgentToolAccess({ name: "x", access: "propose" })).not.toThrow()
    expect(() => assertAiAgentToolAccess({ name: "x", access: "write" })).toThrow(
      /may only read directly or propose/,
    )
  })

  test("without a governance port there is no way to propose anything", () => {
    const registry = createAiAgentToolRegistry({
      readTools: createAiToolRegistry([readTool("crm_query")]),
    })
    expect(registry.names()).toEqual(["crm_query"])
    expect(registry.get(AI_AGENT_TOOL_PROPOSE)).toBeNull()
  })

  test("the allowlist narrows the registry, and unknown names are dropped", () => {
    const { port } = recordingProposalPort()
    const registry = createAiAgentToolRegistry({
      readTools: createAiToolRegistry([readTool("crm_query"), readTool("crm_describe_objects")]),
      proposals: port,
    })
    expect(registry.subset(["crm_query", "nonsense"]).map((tool) => tool.name)).toEqual([
      "crm_query",
    ])
    expect(registry.definitions(["crm_query"])).toHaveLength(1)
    expect(registry.definitions([])).toHaveLength(0)
  })
})

describe("ai-agents/proposal tool", () => {
  test("it queues a request as an `agent` actor and never claims the change happened", async () => {
    const { port, calls } = recordingProposalPort()
    const tool = createAiAgentProposalTool({ proposals: port })

    const execution = await tool.execute(ctx, {
      objectType: "person",
      recordId: "p1",
      action: "update",
      before: { title: null },
      after: { title: "Head of Ops" },
      rationale: "The signature says Head of Ops.",
    })

    expect(calls).toHaveLength(1)
    // Attribution comes from the RUN, never from the model.
    expect(calls[0]?.ctx.actorType).toBe("agent")
    expect(calls[0]?.ctx.actorId).toBe("user-1")
    expect(calls[0]?.ctx.agentId).toBe("agent-1")
    expect(calls[0]?.input).toMatchObject({
      objectType: "person",
      recordId: "p1",
      action: "update",
      runId: "run-1",
      model: "stub-echo-1",
      agentId: "agent-1",
    })

    const result = execution.result as { status: string; message: string; applied: boolean }
    expect(result.status).toBe("pending")
    expect(result.applied).toBe(false)
    expect(result.message).toContain("Nothing has changed yet")
    expect(execution.summary).toContain("pending")
  })

  test("a malformed proposal is refused before it reaches the queue", async () => {
    const { port, calls } = recordingProposalPort()
    const tool = createAiAgentProposalTool({ proposals: port })
    await expect(tool.execute(ctx, { objectType: "person", action: "update" })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})
