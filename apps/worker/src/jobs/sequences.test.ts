import { afterEach, describe, expect, test } from "bun:test"
import {
  registerSequenceStepRunner,
  resetSequenceStepRunner,
  runSequenceStepJob,
  sequenceStepJobId,
  sequenceStepJobPayloadSchema,
  SequenceStepRunnerNotBoundError,
  SEQUENCE_STEP_JOB_NAME,
  type SequenceStepJobPayload,
} from "./sequences"
import { JobHandlers } from "../worker"

const payload: SequenceStepJobPayload = {
  workspaceId: "ws_1",
  sequenceId: "seq_1",
  enrollmentId: "enr_1",
  stepIndex: 0,
}

afterEach(() => {
  resetSequenceStepRunner()
})

describe("worker/sequence-step", () => {
  test("the handler is registered under the queue seam's job name", () => {
    expect(Object.keys(JobHandlers)).toContain(SEQUENCE_STEP_JOB_NAME)
    expect(SEQUENCE_STEP_JOB_NAME).toBe("sequence.step")
  })

  test("the payload is validated at run time, not just at enqueue", async () => {
    expect(sequenceStepJobPayloadSchema.parse(payload).enrollmentId).toBe("enr_1")
    await expect(runSequenceStepJob({ ...payload, enrollmentId: "" })).rejects.toThrow()
    await expect(runSequenceStepJob({ ...payload, stepIndex: -1 })).rejects.toThrow()
    await expect(runSequenceStepJob({ nope: true })).rejects.toThrow()
  })

  test("an unbound runner fails loudly instead of dropping the step", async () => {
    await expect(runSequenceStepJob(payload)).rejects.toThrow(SequenceStepRunnerNotBoundError)
  })

  test("a bound runner receives the validated payload", async () => {
    const seen: SequenceStepJobPayload[] = []
    registerSequenceStepRunner(async (input) => {
      seen.push(input)
      return {
        enrollmentId: input.enrollmentId,
        stepIndex: input.stepIndex,
        outcome: "executed",
        status: "active",
      }
    })
    const result = await runSequenceStepJob(payload)
    expect(result.outcome).toBe("executed")
    expect(seen[0]?.sequenceId).toBe("seq_1")
  })

  /**
   * The transport-level half of the send-once guarantee. It must be keyed
   * on the same pair as the database claim — (enrollment, step index) —
   * or the two guards could disagree.
   */
  test("the job id is deterministic per (enrollment, step index)", () => {
    expect(sequenceStepJobId(payload)).toBe("sequence.step:ws_1:enr_1:0")
    expect(sequenceStepJobId({ ...payload, stepIndex: 1 })).not.toBe(sequenceStepJobId(payload))
    expect(sequenceStepJobId({ ...payload, enrollmentId: "enr_2" })).not.toBe(
      sequenceStepJobId(payload),
    )
    // Re-deriving it from the same payload yields the same id, which is
    // what makes a duplicate enqueue a no-op in BullMQ.
    expect(sequenceStepJobId(payload)).toBe(sequenceStepJobId({ ...payload }))
  })

  /**
   * EXIT CONDITIONS travel through the runner, not the transport: a job
   * queued before the prospect replied still arrives, and the runner
   * reports the no-op rather than sending. The handler must pass that
   * through as a SUCCESS, or BullMQ would retry a deliberate no-op five
   * times.
   */
  test("a step for a stopped enrollment resolves as a no-op, never a retry", async () => {
    let calls = 0
    registerSequenceStepRunner(async (input) => {
      calls += 1
      return {
        enrollmentId: input.enrollmentId,
        stepIndex: input.stepIndex,
        outcome: "enrollment_not_active",
        status: "stopped",
      }
    })
    const result = await runSequenceStepJob(payload)
    expect(result).toMatchObject({ outcome: "enrollment_not_active", status: "stopped" })
    expect(calls).toBe(1)
  })

  test("IDEMPOTENCY: retrying the job re-delegates, and the runner no-ops", async () => {
    const outcomes = ["executed", "already_attempted"]
    let attempt = 0
    registerSequenceStepRunner(async (input) => {
      const outcome = outcomes[attempt] ?? "already_attempted"
      attempt += 1
      return {
        enrollmentId: input.enrollmentId,
        stepIndex: input.stepIndex,
        outcome,
        status: "active",
      }
    })
    expect((await runSequenceStepJob(payload)).outcome).toBe("executed")
    expect((await runSequenceStepJob(payload)).outcome).toBe("already_attempted")
  })

  test("a runner failure propagates so BullMQ can retry and dead-letter", async () => {
    registerSequenceStepRunner(async () => {
      throw new Error("provider timeout")
    })
    await expect(runSequenceStepJob(payload)).rejects.toThrow("provider timeout")
  })
})
