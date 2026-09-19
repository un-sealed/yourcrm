import { afterEach, describe, expect, test } from "bun:test"
import {
  aiAgentRunJobId,
  aiAgentRunJobPayloadSchema,
  registerAiAgentRunner,
  resetAiAgentRunner,
  runAiAgentJob,
  AiAgentRunnerNotBoundError,
  AI_AGENT_RUN_JOB_NAME,
  type AiAgentRunJobPayload,
} from "./ai-agent"
import { JobHandlers } from "../worker"

const payload: AiAgentRunJobPayload = {
  workspaceId: "ws_1",
  agentId: "agent_1",
  runId: "run_1",
  triggerEventId: "evt_1",
}

afterEach(() => {
  resetAiAgentRunner()
})

describe("worker/ai-agent-run", () => {
  test("the handler is registered under the queue seam's job name", () => {
    expect(Object.keys(JobHandlers)).toContain(AI_AGENT_RUN_JOB_NAME)
    expect(AI_AGENT_RUN_JOB_NAME).toBe("ai.agent.run")
  })

  test("the payload is validated at run time, not just at enqueue", async () => {
    expect(aiAgentRunJobPayloadSchema.parse(payload).runId).toBe("run_1")
    await expect(runAiAgentJob({ ...payload, runId: "" })).rejects.toThrow()
    await expect(runAiAgentJob({ nope: true })).rejects.toThrow()
  })

  test("an unbound runner fails loudly instead of silently dropping the run", async () => {
    await expect(runAiAgentJob(payload)).rejects.toThrow(AiAgentRunnerNotBoundError)
  })

  test("the job id is deterministic per (agent, triggering event)", () => {
    expect(aiAgentRunJobId(payload)).toBe("ai.agent.run:ws_1:agent_1:evt_1")
    // A retry with a different run id still collapses onto one job: the
    // id is a function of the agent and the triggering event, nothing else.
    expect(
      aiAgentRunJobId({
        workspaceId: payload.workspaceId,
        agentId: payload.agentId,
        triggerEventId: payload.triggerEventId,
      }),
    ).toBe("ai.agent.run:ws_1:agent_1:evt_1")
  })

  test("the payload carries no actor, no role and no budget to spoof", () => {
    const keys = Object.keys(aiAgentRunJobPayloadSchema.shape)
    expect(keys).toEqual(["workspaceId", "agentId", "runId", "triggerEventId", "correlationId"])
  })

  test("a bound runner is called once and its accounting is returned", async () => {
    const calls: AiAgentRunJobPayload[] = []
    registerAiAgentRunner(async (input) => {
      calls.push(input)
      return {
        runId: input.runId,
        status: "succeeded",
        steps: 2,
        proposalCount: 1,
        totalTokens: 1_300,
        latencyMs: 200,
        costMicros: 2,
      }
    })
    const result = await runAiAgentJob(payload)
    expect(calls).toHaveLength(1)
    expect(result.status).toBe("succeeded")
    expect(result.proposalCount).toBe(1)
    expect(result.costMicros).toBe(2)
  })
})
