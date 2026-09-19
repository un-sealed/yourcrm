import { afterEach, describe, expect, test } from "bun:test"
import {
  AutomationCascadeLimitError,
  AUTOMATION_RUN_JOB_NAME,
  automationRunJobPayloadSchema,
  registerWorkflowRunner,
  resetWorkflowRunner,
  runAutomationJob,
  WorkflowRunnerNotBoundError,
  type AutomationRunJobPayload,
} from "./automation"
import { JobHandlers } from "../worker"

const payload: AutomationRunJobPayload = {
  workspaceId: "ws_1",
  workflowId: "wf_1",
  runId: "run_1",
  triggerEventId: "evt_1",
  depth: 0,
  maxDepth: 5,
}

afterEach(() => {
  resetWorkflowRunner()
})

describe("worker/automation-run", () => {
  test("the handler is registered under the queue seam's job name", () => {
    expect(Object.keys(JobHandlers)).toContain(AUTOMATION_RUN_JOB_NAME)
    expect(AUTOMATION_RUN_JOB_NAME).toBe("automation.run")
  })

  test("the payload is validated at run time, not just at enqueue", async () => {
    expect(automationRunJobPayloadSchema.parse(payload).runId).toBe("run_1")
    await expect(runAutomationJob({ ...payload, runId: "" })).rejects.toThrow()
    await expect(runAutomationJob({ nope: true })).rejects.toThrow()
  })

  test("an unbound runner fails loudly instead of dropping the run", async () => {
    await expect(runAutomationJob(payload)).rejects.toThrow(WorkflowRunnerNotBoundError)
  })

  test("a bound runner receives the validated payload", async () => {
    const seen: AutomationRunJobPayload[] = []
    registerWorkflowRunner(async (input) => {
      seen.push(input)
      return { runId: input.runId, status: "succeeded", executedSteps: 1 }
    })
    const result = await runAutomationJob(payload)
    expect(result).toEqual({ runId: "run_1", status: "succeeded", executedSteps: 1 })
    expect(seen[0]?.triggerEventId).toBe("evt_1")
  })

  test("LOOP PROTECTION: a payload past the ceiling never reaches the runner", async () => {
    let called = 0
    registerWorkflowRunner(async (input) => {
      called += 1
      return { runId: input.runId, status: "succeeded", executedSteps: 0 }
    })
    await expect(runAutomationJob({ ...payload, depth: 6, maxDepth: 5 })).rejects.toThrow(
      AutomationCascadeLimitError,
    )
    expect(called).toBe(0)
    // Depth exactly at the ceiling still runs.
    await runAutomationJob({ ...payload, depth: 5, maxDepth: 5 })
    expect(called).toBe(1)
  })

  test("IDEMPOTENCY: retrying the job re-delegates, and the runner no-ops", async () => {
    // `executeRun` returns without executing a step once the run is
    // terminal, so a BullMQ retry costs one lookup and changes nothing.
    let executions = 0
    registerWorkflowRunner(async (input) => {
      const finished = executions > 0
      if (!finished) executions += 1
      return {
        runId: input.runId,
        status: "succeeded",
        executedSteps: finished ? 0 : 1,
      }
    })
    const first = await runAutomationJob(payload)
    const second = await runAutomationJob(payload)
    expect(first.executedSteps).toBe(1)
    expect(second.executedSteps).toBe(0)
    expect(executions).toBe(1)
  })
})
