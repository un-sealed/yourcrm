import { describe, expect, test } from "bun:test"
import { AutomationEvents } from "@yourcrm/events"
import {
  assertWorkflowCascadeDepth,
  createInMemoryWorkflowRunQueue,
  WorkflowCascadeLimitError,
  workflowRunJobId,
  workflowRunJobPayloadSchema,
  WORKFLOW_RUN_EVENTS,
  WORKFLOW_RUN_JOB_NAME,
} from "./queue"

const payload = {
  workspaceId: "ws_1",
  workflowId: "wf_1",
  runId: "run_1",
  triggerEventId: "evt_1",
  depth: 0,
  maxDepth: 5,
}

describe("workflows/queue-contract", () => {
  test("payload is validated at the boundary", () => {
    expect(workflowRunJobPayloadSchema.parse(payload).runId).toBe("run_1")
    expect(() => workflowRunJobPayloadSchema.parse({ ...payload, runId: "" })).toThrow()
    expect(() => workflowRunJobPayloadSchema.parse({ ...payload, depth: -1 })).toThrow()
  })

  test("job id is derived from the idempotency key, not the run id", () => {
    const id = workflowRunJobId(payload)
    expect(id).toBe(`${WORKFLOW_RUN_JOB_NAME}:ws_1:wf_1:evt_1`)
    // A second run row for the same event would still collapse onto one job.
    expect(
      workflowRunJobId({ workspaceId: "ws_1", workflowId: "wf_1", triggerEventId: "evt_1" }),
    ).toBe(id)
  })

  test("engine events come from the @yourcrm/events constants", () => {
    expect(WORKFLOW_RUN_EVENTS.RunStarted).toBe(AutomationEvents.RunStarted)
    expect(WORKFLOW_RUN_EVENTS.StepFailed).toBe(AutomationEvents.StepFailed)
    expect(WORKFLOW_RUN_EVENTS.Completed).toBe(AutomationEvents.Completed)
  })
})

describe("workflows/cascade-guard", () => {
  test("depth at the ceiling is allowed, past it is refused", () => {
    expect(() => assertWorkflowCascadeDepth(5, 5)).not.toThrow()
    expect(() => assertWorkflowCascadeDepth(6, 5)).toThrow(WorkflowCascadeLimitError)
  })
})

describe("workflows/in-memory-queue", () => {
  test("enqueue records a validated job", async () => {
    const queue = createInMemoryWorkflowRunQueue()
    await queue.enqueueWorkflowRun(payload)
    expect(queue.jobs).toHaveLength(1)
    expect(queue.jobs[0]?.jobId).toBe(workflowRunJobId(payload))
  })

  test("the same triggering event enqueues exactly once", async () => {
    const queue = createInMemoryWorkflowRunQueue()
    await queue.enqueueWorkflowRun(payload)
    await queue.enqueueWorkflowRun({ ...payload, runId: "run_2" })
    expect(queue.jobs).toHaveLength(1)
  })

  test("a payload past the cascade ceiling never reaches the transport", async () => {
    const queue = createInMemoryWorkflowRunQueue()
    await expect(queue.enqueueWorkflowRun({ ...payload, depth: 9 })).rejects.toThrow(
      WorkflowCascadeLimitError,
    )
    expect(queue.jobs).toHaveLength(0)
  })

  test("the enqueue hook lets a test drive the run inline", async () => {
    const seen: string[] = []
    const queue = createInMemoryWorkflowRunQueue((job) => {
      seen.push(job.runId)
    })
    await queue.enqueueWorkflowRun(payload)
    expect(seen).toEqual(["run_1"])
    queue.reset()
    expect(queue.jobs).toHaveLength(0)
  })
})
