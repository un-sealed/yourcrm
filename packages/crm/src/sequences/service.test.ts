import { beforeEach, describe, expect, test } from "bun:test"
import { CommunicationEvents, createEvent, EventBus } from "@yourcrm/events"
import {
  createStore,
  expectDenied,
  makeBaseRecord,
  makeServiceContext,
  nextId,
} from "@yourcrm/testing"
import type { BaseRecord, ServiceContext } from "@yourcrm/validation"
import {
  createSalesSequenceService,
  salesSequenceCorrelationId,
  subscribeSalesSequenceExits,
} from "./service"
import type {
  SalesSequenceAuditInput,
  SalesSequenceEnrollmentListQuery,
  SalesSequenceEnrollmentRecord,
  SalesSequenceRecord,
  SalesSequenceStepDraft,
  SalesSequenceStepJobRequest,
  SalesSequenceStepRecord,
  SalesSequenceStepRunRecord,
  SalesSequenceStore,
} from "./types"

/**
 * Hermetic engine tests. No Postgres, no Redis: the store fake reproduces
 * the two UNIQUE indexes from migration 0270 (one enrollment per
 * (sequence, person), one step run per (enrollment, step index)), and the
 * queue fake records enqueues so a whole enrol -> send -> reply -> silence
 * chain is observable in one test.
 *
 * The properties the module exists for each get a named test:
 *   sequences/exit-on-reply          — a replied-to enrollment sends nothing more
 *   sequences/idempotency            — a retried job sends once
 *   sequences/permission-inheritance — a viewer-owned sequence cannot send
 */

const WS = "ws_seq_1"

type StoredSequence = BaseRecord & {
  name: string
  description: string | null
  status: string
  ownerId: string | null
  exitOnReply: boolean
  exitOnBounce: boolean
  lastEnrolledAt: string | null
}

function asSequence(row: StoredSequence): SalesSequenceRecord {
  return row as unknown as SalesSequenceRecord
}

/** Store fake with migration 0270's uniqueness guarantees, nothing more. */
function createFakeSequenceStore() {
  const sequences = createStore<StoredSequence>()
  const steps = new Map<string, SalesSequenceStepRecord[]>()
  const enrollments = new Map<string, SalesSequenceEnrollmentRecord>()
  const enrollmentByPerson = new Map<string, string>()
  const runs = new Map<string, SalesSequenceStepRunRecord>()
  const runByStep = new Map<string, string>()

  const store: SalesSequenceStore = {
    list: async (workspaceId, query) => {
      let rows = sequences.list(workspaceId)
      if (query.status) rows = rows.filter((r) => r.status === query.status)
      if (query.ownerId) rows = rows.filter((r) => r.ownerId === query.ownerId)
      if (query.query) {
        const needle = query.query.toLowerCase()
        rows = rows.filter((r) => r.name.toLowerCase().includes(needle))
      }
      const limit = query.limit ?? 25
      return { data: rows.slice(0, limit).map(asSequence), pagination: { nextCursor: null, limit } }
    },
    findById: async (workspaceId, id) => {
      const row = sequences.get(id, workspaceId)
      return row ? asSequence(row) : null
    },
    create: async (workspaceId, input, actorId) =>
      asSequence(
        sequences.insert({
          ...makeBaseRecord({ workspaceId }),
          name: String(input.name ?? ""),
          description: (input.description as string | null) ?? null,
          status: (input.status as string | null) ?? "draft",
          ownerId: (input.ownerId as string | null) ?? actorId ?? null,
          exitOnReply: input.exitOnReply === undefined ? true : Boolean(input.exitOnReply),
          exitOnBounce: input.exitOnBounce === undefined ? true : Boolean(input.exitOnBounce),
          lastEnrolledAt: null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      ),
    update: async (workspaceId, id, input) => {
      const row = sequences.update(id, workspaceId, input as Partial<StoredSequence>)
      return row ? asSequence(row) : null
    },
    softDelete: async (workspaceId, id) => {
      sequences.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      sequences.restore(id, workspaceId)
    },
    markEnrolled: async (workspaceId, id) => {
      sequences.update(id, workspaceId, { lastEnrolledAt: new Date().toISOString() })
    },

    listSteps: async (_workspaceId, sequenceId) => steps.get(sequenceId) ?? [],
    replaceSteps: async (workspaceId, sequenceId, drafts) => {
      const rows = drafts.map((draft, index) => ({
        id: nextId("step"),
        workspaceId,
        sequenceId,
        stepIndex: index,
        stepType: draft.stepType,
        name: draft.name ?? null,
        waitDays: draft.waitDays ?? 0,
        waitHours: draft.waitHours ?? 0,
        config: draft.config ?? {},
      }))
      steps.set(sequenceId, rows)
      return rows
    },

    // Mirrors UNIQUE (sequence_id, person_id) + ON CONFLICT DO NOTHING.
    enrollPerson: async (workspaceId, input) => {
      const key = `${String(input.sequenceId)}:${String(input.personId)}`
      const existingId = enrollmentByPerson.get(key)
      if (existingId) {
        const existing = enrollments.get(existingId)
        if (existing) return { enrollment: existing, created: false }
      }
      const enrollment: SalesSequenceEnrollmentRecord = {
        ...(input as Record<string, unknown>),
        id: nextId("enr"),
        workspaceId,
        sequenceId: String(input.sequenceId),
        personId: String(input.personId),
        emailAddress: String(input.emailAddress),
        status: "active",
        exitReason: null,
        currentStepIndex: 0,
        threadId: null,
        sentCount: 0,
      }
      enrollments.set(enrollment.id, enrollment)
      enrollmentByPerson.set(key, enrollment.id)
      return { enrollment, created: true }
    },
    findEnrollmentById: async (workspaceId, id) => {
      const row = enrollments.get(id)
      return row && row.workspaceId === workspaceId ? row : null
    },
    listEnrollments: async (workspaceId: string, query: SalesSequenceEnrollmentListQuery) => {
      let rows = [...enrollments.values()].filter((r) => r.workspaceId === workspaceId)
      if (query.sequenceId) rows = rows.filter((r) => r.sequenceId === query.sequenceId)
      if (query.personId) rows = rows.filter((r) => r.personId === query.personId)
      if (query.status) rows = rows.filter((r) => r.status === query.status)
      if (query.exitReason) rows = rows.filter((r) => r.exitReason === query.exitReason)
      const limit = query.limit ?? 25
      return { data: rows.slice(0, limit), pagination: { nextCursor: null, limit } }
    },
    updateEnrollment: async (workspaceId, id, patch) => {
      const row = enrollments.get(id)
      if (!row || row.workspaceId !== workspaceId) return null
      const next: SalesSequenceEnrollmentRecord = {
        ...row,
        ...patch,
        status: String(patch.status ?? row.status),
        currentStepIndex: Number(patch.currentStepIndex ?? row.currentStepIndex),
      }
      enrollments.set(id, next)
      return next
    },
    incrementSentCount: async (workspaceId, id) => {
      const row = enrollments.get(id)
      if (!row || row.workspaceId !== workspaceId) return null
      const next = { ...row, sentCount: Number(row.sentCount ?? 0) + 1 }
      enrollments.set(id, next)
      return next
    },
    findActiveEnrollmentsByTarget: async (workspaceId, target) =>
      [...enrollments.values()].filter(
        (row) =>
          row.workspaceId === workspaceId &&
          (row.status === "active" || row.status === "paused") &&
          ((target.threadId != null && row.threadId === target.threadId) ||
            (target.personId != null && row.personId === target.personId) ||
            (target.emailAddress != null &&
              row.emailAddress === target.emailAddress.toLowerCase())),
      ),
    findSuppression: async (workspaceId, target) =>
      [...enrollments.values()].find(
        (row) =>
          row.workspaceId === workspaceId &&
          (row.exitReason === "unsubscribed" || row.exitReason === "bounced") &&
          ((target.personId != null && row.personId === target.personId) ||
            (target.emailAddress != null &&
              row.emailAddress === target.emailAddress.toLowerCase())),
      ) ?? null,

    // Mirrors UNIQUE (enrollment_id, step_index) + ON CONFLICT DO NOTHING.
    claimStepRun: async (workspaceId, input) => {
      const key = `${input.enrollmentId}:${input.stepIndex}`
      const existingId = runByStep.get(key)
      if (existingId) {
        const existing = runs.get(existingId)
        if (existing) return { run: existing, claimed: false }
      }
      const run: SalesSequenceStepRunRecord = {
        id: nextId("run"),
        workspaceId,
        enrollmentId: input.enrollmentId,
        stepIndex: input.stepIndex,
        stepType: input.stepType,
        stepId: input.stepId ?? null,
        actorId: input.actorId ?? null,
        actorRole: input.actorRole ?? null,
        status: "running",
      }
      runs.set(run.id, run)
      runByStep.set(key, run.id)
      return { run, claimed: true }
    },
    completeStepRun: async (_workspaceId, id, patch) => {
      const run = runs.get(id)
      if (!run) return null
      const next = { ...run, ...patch, status: String(patch.status ?? run.status) }
      runs.set(id, next)
      return next
    },
    listStepRuns: async (_workspaceId, enrollmentId) =>
      [...runs.values()]
        .filter((r) => r.enrollmentId === enrollmentId)
        .sort((a, b) => a.stepIndex - b.stepIndex),

    stats: async (workspaceId, sequenceId) => {
      const mine = [...enrollments.values()].filter(
        (r) => r.workspaceId === workspaceId && r.sequenceId === sequenceId,
      )
      const ids = new Set(mine.map((r) => r.id))
      return {
        enrollments: mine.map((r) => ({
          status: r.status,
          exitReason: (r.exitReason as string | null) ?? null,
          count: 1,
        })),
        steps: [...runs.values()]
          .filter((r) => ids.has(r.enrollmentId))
          .map((r) => ({
            stepIndex: r.stepIndex,
            stepType: String(r.stepType),
            status: r.status,
            count: 1,
          })),
      }
    },
  }

  return { store, sequences, steps, enrollments, runs }
}

type SentEmail = { ctx: ServiceContext; to: string; subject: string; bodyText: string }
type CreatedTask = { ctx: ServiceContext; title: string }

function createFakeExecutor(threadId = "thread_1") {
  const emails: SentEmail[] = []
  const tasks: CreatedTask[] = []
  return {
    emails,
    tasks,
    executor: {
      sendSequenceEmail: async (
        ctx: ServiceContext,
        input: { to: string; subject: string; bodyText: string },
      ) => {
        emails.push({ ctx, to: input.to, subject: input.subject, bodyText: input.bodyText })
        return { messageId: nextId("msg"), threadId }
      },
      createSequenceTask: async (ctx: ServiceContext, input: { title: string }) => {
        tasks.push({ ctx, title: input.title })
        return { taskId: nextId("task") }
      },
    },
  }
}

/** Queue double: records enqueues. Steps are driven explicitly in tests. */
function createFakeQueue(onEnqueue?: (request: SalesSequenceStepJobRequest) => Promise<void>) {
  const enqueued: SalesSequenceStepJobRequest[] = []
  return {
    enqueued,
    queue: {
      enqueueSequenceStep: async (request: SalesSequenceStepJobRequest) => {
        enqueued.push(request)
        if (onEnqueue) await onEnqueue(request)
      },
    },
  }
}

type Harness = ReturnType<typeof makeHarness>

const ROLES: Record<string, string> = {
  owner_member: "member",
  owner_admin: "admin",
  owner_viewer: "viewer",
}

function makeHarness(
  options: {
    roles?: Record<string, string>
    contactEmail?: string | null
    onEnqueue?: (request: SalesSequenceStepJobRequest) => Promise<void>
    queueThrows?: boolean
  } = {},
) {
  const fake = createFakeSequenceStore()
  const { executor, emails, tasks } = createFakeExecutor()
  const audits: SalesSequenceAuditInput[] = []
  const roles = options.roles ?? ROLES
  const { enqueued, queue } = createFakeQueue(options.onEnqueue)

  const service = createSalesSequenceService({
    store: fake.store,
    audit: async (input) => {
      audits.push(input)
    },
    queue: options.queueThrows
      ? {
          enqueueSequenceStep: async () => {
            throw new Error("redis is down")
          },
        }
      : queue,
    executor,
    resolveActorRole: async (_workspaceId, actorId) => roles[actorId] ?? null,
    resolveContact: async (_workspaceId, personId) =>
      options.contactEmail === null
        ? { personId, emailAddress: null }
        : { personId, emailAddress: options.contactEmail ?? "ada@example.com" },
  })

  return { ...fake, service, emails, tasks, audits, enqueued, roles }
}

const EMAIL_STEP = {
  stepType: "email" as const,
  subject: "Hello {{email}}",
  bodyText: "Are you free this week?",
}
const FOLLOW_UP_STEP = {
  stepType: "email" as const,
  waitDays: 3,
  subject: "Following up",
  bodyText: "Just checking in.",
}

function adminCtx(actorId = "owner_admin"): ServiceContext {
  return makeServiceContext({ workspaceId: WS, actorId, role: "admin" })
}

function memberCtx(actorId = "owner_member"): ServiceContext {
  return makeServiceContext({ workspaceId: WS, actorId, role: "member" })
}

/** Create + populate + activate a sequence owned by `ownerId`. */
async function seedActiveSequence(
  h: Harness,
  options: { ownerId?: string; steps?: unknown[]; exitOnReply?: boolean } = {},
): Promise<SalesSequenceRecord> {
  const ownerId = options.ownerId ?? "owner_member"
  const ctx = adminCtx()
  const sequence = await h.service.create(ctx, {
    name: "Outbound v1",
    ownerId,
    ...(options.exitOnReply === undefined ? {} : { exitOnReply: options.exitOnReply }),
  })
  await h.service.replaceSteps(ctx, sequence.id, {
    steps: options.steps ?? [EMAIL_STEP, FOLLOW_UP_STEP],
  })
  return h.service.setStatus(ctx, sequence.id, "active")
}

/* ------------------------------- authoring -------------------------------- */

describe("sequences/authoring", () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  test("a sequence is created as a draft and audited", async () => {
    const sequence = await h.service.create(memberCtx("author_1"), { name: "Outbound v1" })
    expect(sequence.status).toBe("draft")
    expect(sequence.ownerId).toBe("author_1")
    expect(h.audits.at(-1)).toMatchObject({ action: "create", object: "sequence" })
  })

  test("a viewer cannot author a sequence", async () => {
    const viewer = makeServiceContext({ workspaceId: WS, actorId: "viewer_1", role: "viewer" })
    await expectDenied(() => h.service.create(viewer, { name: "Outbound v1" }))
  })

  test("assigning the sequence to somebody else needs admin (it sends as them)", async () => {
    await expectDenied(() =>
      h.service.create(memberCtx("author_1"), { name: "Sneaky", ownerId: "owner_admin" }),
    )
  })

  test("activating needs send_external; pausing only needs update", async () => {
    const ctx = adminCtx()
    const sequence = await h.service.create(ctx, { name: "Outbound v1" })
    await h.service.replaceSteps(ctx, sequence.id, { steps: [EMAIL_STEP] })

    const viewer = makeServiceContext({ workspaceId: WS, actorId: "viewer_1", role: "viewer" })
    await expectDenied(() => h.service.setStatus(viewer, sequence.id, "active"))

    const active = await h.service.setStatus(memberCtx(), sequence.id, "active")
    expect(active.status).toBe("active")

    // Stopping a running sequence must never be harder than starting it.
    const paused = await h.service.setStatus(viewer, sequence.id, "paused").catch(() => null)
    expect(paused).toBeNull() // a viewer cannot even update
    const memberPaused = await h.service.setStatus(memberCtx(), sequence.id, "paused")
    expect(memberPaused.status).toBe("paused")
  })

  test("a sequence with no steps cannot be activated", async () => {
    const ctx = adminCtx()
    const sequence = await h.service.create(ctx, { name: "Empty" })
    await expect(h.service.setStatus(ctx, sequence.id, "active")).rejects.toThrow(
      /at least one step/,
    )
  })

  test("the step editor saves an ordered list and re-derives the index", async () => {
    const ctx = adminCtx()
    const sequence = await h.service.create(ctx, { name: "Outbound v1" })
    const steps = await h.service.replaceSteps(ctx, sequence.id, {
      steps: [EMAIL_STEP, { stepType: "wait", waitDays: 2 }, { stepType: "task", title: "Call" }],
    })
    expect(steps.map((s) => [s.stepIndex, s.stepType])).toEqual([
      [0, "email"],
      [1, "wait"],
      [2, "task"],
    ])
  })

  test("a wait step with no delay is rejected", async () => {
    const ctx = adminCtx()
    const sequence = await h.service.create(ctx, { name: "Outbound v1" })
    await expect(
      h.service.replaceSteps(ctx, sequence.id, { steps: [{ stepType: "wait" }] }),
    ).rejects.toThrow()
  })

  test("an unauthenticated caller cannot list sequences or enrollments", async () => {
    const stranger = makeServiceContext({ workspaceId: WS, actorId: "", role: "viewer" })
    await expectDenied(() => h.service.list(stranger, {}))
    await expectDenied(() => h.service.listEnrollments(stranger, {}))
  })
})

/* ------------------------------ enrollment -------------------------------- */

describe("sequences/enrollment", () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  test("enrolling queues the first step and audits", async () => {
    const sequence = await seedActiveSequence(h)
    const { enrollment, created } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    expect(created).toBe(true)
    expect(enrollment.emailAddress).toBe("ada@example.com")
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0]).toMatchObject({ enrollmentId: enrollment.id, stepIndex: 0 })
    expect(h.audits.some((a) => a.action === "enroll")).toBe(true)
  })

  test("enrolling the same person twice does not start a second drip", async () => {
    const sequence = await seedActiveSequence(h)
    const first = await h.service.enroll(memberCtx(), sequence.id, { personId: "person_1" })
    const second = await h.service.enroll(memberCtx(), sequence.id, { personId: "person_1" })
    expect(second.created).toBe(false)
    expect(second.enrollment.id).toBe(first.enrollment.id)
    expect(h.enqueued).toHaveLength(1)
  })

  test("a draft sequence cannot enrol anybody", async () => {
    const ctx = adminCtx()
    const sequence = await h.service.create(ctx, { name: "Outbound v1" })
    await h.service.replaceSteps(ctx, sequence.id, { steps: [EMAIL_STEP] })
    await expect(h.service.enroll(ctx, sequence.id, { personId: "person_1" })).rejects.toThrow(
      /activate it/,
    )
  })

  test("a person with no email address cannot be enrolled", async () => {
    const noEmail = makeHarness({ contactEmail: null })
    const sequence = await seedActiveSequence(noEmail)
    await expect(
      noEmail.service.enroll(memberCtx(), sequence.id, { personId: "person_1" }),
    ).rejects.toThrow(/no email address/)
  })

  test("a viewer cannot enrol anybody", async () => {
    const sequence = await seedActiveSequence(h)
    const viewer = makeServiceContext({ workspaceId: WS, actorId: "viewer_1", role: "viewer" })
    await expectDenied(() => h.service.enroll(viewer, sequence.id, { personId: "person_1" }))
  })
})

/* ---------------------------- EXIT CONDITIONS ------------------------------ */

describe("sequences/exit-on-reply", () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  /**
   * THE test this module exists to pass. A sequence that keeps emailing
   * somebody who replied is worse than no sequence, so the assertion is
   * not "the enrollment is marked stopped" — it is "the job that was
   * ALREADY QUEUED when the reply landed sends nothing".
   */
  test("a replied-to enrollment sends no further steps", async () => {
    const sequence = await seedActiveSequence(h)
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })

    // Step 0 goes out and step 1 is queued for three days' time.
    await h.service.executeStep(WS, enrollment.id, 0)
    expect(h.emails).toHaveLength(1)
    expect(h.enqueued.map((job) => job.stepIndex)).toEqual([0, 1])

    // The prospect replies. The email module emits `email.received` with
    // the thread our step created.
    const result = await h.service.handleInboundEvent(
      createEvent({
        event: CommunicationEvents.EmailReceived,
        workspaceId: WS,
        entityType: "email_message",
        entityId: "msg_in_1",
        after: { threadId: "thread_1", direction: "inbound" },
      }),
    )
    expect(result.reason).toBe("replied")
    expect(result.stopped.map((s) => s.enrollmentId)).toEqual([enrollment.id])

    const stopped = await h.service.getEnrollment(memberCtx(), enrollment.id)
    expect(stopped.enrollment.status).toBe("stopped")
    expect(stopped.enrollment.exitReason).toBe("replied")

    // NOW run the step that was already on the queue. It must do nothing.
    const outcome = await h.service.executeStep(WS, enrollment.id, 1)
    expect(outcome.outcome).toBe("enrollment_not_active")
    expect(h.emails).toHaveLength(1)
    expect(h.tasks).toHaveLength(0)
    // And no third job was scheduled behind it.
    expect(h.enqueued.map((job) => job.stepIndex)).toEqual([0, 1])
  })

  test("our own outbound copy on the same thread is not a reply", async () => {
    const sequence = await seedActiveSequence(h)
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    await h.service.executeStep(WS, enrollment.id, 0)

    const result = await h.service.handleInboundEvent(
      createEvent({
        event: CommunicationEvents.EmailSent,
        workspaceId: WS,
        after: { threadId: "thread_1", direction: "outbound" },
      }),
    )
    expect(result.stopped).toHaveLength(0)

    const ignored = await h.service.handleInboundEvent(
      createEvent({
        event: CommunicationEvents.EmailReceived,
        workspaceId: WS,
        after: { threadId: "thread_1", direction: "outbound" },
      }),
    )
    expect(ignored.stopped).toHaveLength(0)

    const live = await h.service.getEnrollment(memberCtx(), enrollment.id)
    expect(live.enrollment.status).toBe("active")
  })

  test("a sequence with exitOnReply off keeps going", async () => {
    const sequence = await seedActiveSequence(h, { exitOnReply: false })
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    await h.service.executeStep(WS, enrollment.id, 0)
    const result = await h.service.handleInboundEvent(
      createEvent({
        event: CommunicationEvents.EmailReceived,
        workspaceId: WS,
        after: { threadId: "thread_1", direction: "inbound" },
      }),
    )
    expect(result.stopped).toHaveLength(0)
  })

  test("a bounce stops the enrollment", async () => {
    const sequence = await seedActiveSequence(h)
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    await h.service.executeStep(WS, enrollment.id, 0)
    await h.service.handleInboundEvent(
      createEvent({
        event: CommunicationEvents.EmailBounced,
        workspaceId: WS,
        after: { threadId: "thread_1" },
      }),
    )
    const stopped = await h.service.getEnrollment(memberCtx(), enrollment.id)
    expect(stopped.enrollment.exitReason).toBe("bounced")
    expect(await h.service.executeStep(WS, enrollment.id, 1)).toMatchObject({
      outcome: "enrollment_not_active",
    })
    expect(h.emails).toHaveLength(1)
  })

  test("an unrelated event stops nothing", async () => {
    const sequence = await seedActiveSequence(h)
    await h.service.enroll(memberCtx(), sequence.id, { personId: "person_1" })
    const result = await h.service.handleInboundEvent(
      createEvent({ event: CommunicationEvents.CallCompleted, workspaceId: WS, after: {} }),
    )
    expect(result.reason).toBeNull()
    expect(result.stopped).toHaveLength(0)
  })

  test("the exit watcher wires the bus to the engine", async () => {
    const bus = new EventBus()
    const unsubscribe = subscribeSalesSequenceExits(bus, h.service)
    const sequence = await seedActiveSequence(h)
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    await h.service.executeStep(WS, enrollment.id, 0)

    await bus.emit(
      createEvent({
        event: CommunicationEvents.EmailReceived,
        workspaceId: WS,
        after: { threadId: "thread_1", direction: "inbound" },
      }),
    )
    unsubscribe()

    const stopped = await h.service.getEnrollment(memberCtx(), enrollment.id)
    expect(stopped.enrollment.exitReason).toBe("replied")
  })

  test("unsubscribing stops every live drip and blocks re-enrolment", async () => {
    const sequence = await seedActiveSequence(h)
    const other = await seedActiveSequence(h)
    const first = await h.service.enroll(memberCtx(), sequence.id, { personId: "person_1" })
    await h.service.enroll(memberCtx(), other.id, { personId: "person_1" })

    const result = await h.service.unsubscribe(memberCtx(), { personId: "person_1" })
    expect(result.stopped).toHaveLength(2)

    const stopped = await h.service.getEnrollment(memberCtx(), first.enrollment.id)
    expect(stopped.enrollment.exitReason).toBe("unsubscribed")

    // A third sequence must not be able to pick them back up.
    const third = await seedActiveSequence(h)
    await expect(h.service.enroll(memberCtx(), third.id, { personId: "person_1" })).rejects.toThrow(
      /suppressed/,
    )
  })

  test("removing somebody by hand is terminal and not resumable", async () => {
    const sequence = await seedActiveSequence(h)
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    const stopped = await h.service.stopEnrollment(memberCtx(), enrollment.id, {})
    expect(stopped.status).toBe("stopped")
    expect(stopped.exitReason).toBe("removed")
    await expect(h.service.resumeEnrollment(memberCtx(), enrollment.id)).rejects.toThrow(
      /cannot be resumed/,
    )
    expect(await h.service.executeStep(WS, enrollment.id, 0)).toMatchObject({
      outcome: "enrollment_not_active",
    })
    expect(h.emails).toHaveLength(0)
  })

  test("archiving a sequence stops its live enrollments", async () => {
    const sequence = await seedActiveSequence(h)
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    await h.service.setStatus(adminCtx(), sequence.id, "archived")
    const stopped = await h.service.getEnrollment(memberCtx(), enrollment.id)
    expect(stopped.enrollment.exitReason).toBe("sequence_archived")
    expect(await h.service.executeStep(WS, enrollment.id, 0)).toMatchObject({
      outcome: "enrollment_not_active",
    })
  })

  test("pausing a whole sequence pauses every drip without ending it", async () => {
    const sequence = await seedActiveSequence(h)
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    await h.service.setStatus(memberCtx(), sequence.id, "paused")
    expect(await h.service.executeStep(WS, enrollment.id, 0)).toMatchObject({
      outcome: "sequence_not_active",
    })
    expect(h.emails).toHaveLength(0)

    await h.service.setStatus(memberCtx(), sequence.id, "active")
    await h.service.executeStep(WS, enrollment.id, 0)
    expect(h.emails).toHaveLength(1)
  })

  test("pausing one enrollment stops its steps; resuming re-queues them", async () => {
    const sequence = await seedActiveSequence(h)
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    await h.service.pauseEnrollment(memberCtx(), enrollment.id)
    expect(await h.service.executeStep(WS, enrollment.id, 0)).toMatchObject({
      outcome: "enrollment_not_active",
    })
    expect(h.emails).toHaveLength(0)

    await h.service.resumeEnrollment(memberCtx(), enrollment.id)
    expect(h.enqueued.filter((j) => j.stepIndex === 0)).toHaveLength(2)
    await h.service.executeStep(WS, enrollment.id, 0)
    expect(h.emails).toHaveLength(1)
  })
})

/* ------------------------------ idempotency -------------------------------- */

describe("sequences/idempotency", () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  /**
   * BullMQ retries a job up to five times. The claim on
   * (enrollment_id, step_index) is what makes that safe: the second
   * attempt loses the insert and must not send.
   */
  test("a retried job sends the step exactly once", async () => {
    const sequence = await seedActiveSequence(h)
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })

    const first = await h.service.executeStep(WS, enrollment.id, 0)
    expect(first.outcome).toBe("executed")
    expect(h.emails).toHaveLength(1)

    // The worker crashed after the send; BullMQ redelivers the same job.
    // The enrollment cursor has already moved, so this is a stale replay.
    const retry = await h.service.executeStep(WS, enrollment.id, 0)
    expect(retry.outcome).toBe("stale_step")
    expect(h.emails).toHaveLength(1)
  })

  /**
   * The harder retry: the worker died BEFORE the cursor advanced, so the
   * redelivered job still looks current. Only the step-run claim can catch
   * this one, and it must.
   */
  test("a retry that arrives before the cursor moved still sends once", async () => {
    const sequence = await seedActiveSequence(h)
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    await h.service.executeStep(WS, enrollment.id, 0)
    expect(h.emails).toHaveLength(1)

    // Rewind the cursor exactly as a crash between "send" and "advance"
    // would have left it, then redeliver.
    await h.store.updateEnrollment(WS, enrollment.id, { currentStepIndex: 0 })
    const retry = await h.service.executeStep(WS, enrollment.id, 0)
    expect(retry.outcome).toBe("already_attempted")
    expect(h.emails).toHaveLength(1)

    // The claim also unsticks the cursor rather than leaving the prospect
    // parked on a step that will never run again.
    const runs = await h.service.getEnrollment(memberCtx(), enrollment.id)
    expect(runs.enrollment.currentStepIndex).toBe(1)
  })

  test("a step run is recorded for every attempted step", async () => {
    const sequence = await seedActiveSequence(h, {
      steps: [EMAIL_STEP, { stepType: "task", title: "Call {{email}}" }],
    })
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    await h.service.executeStep(WS, enrollment.id, 0)
    await h.service.executeStep(WS, enrollment.id, 1)
    const detail = await h.service.getEnrollment(memberCtx(), enrollment.id)
    expect(detail.runs.map((r) => [r.stepIndex, r.status])).toEqual([
      [0, "succeeded"],
      [1, "succeeded"],
    ])
    expect(h.tasks[0]?.title).toBe("Call ada@example.com")
  })

  test("running past the last step completes the enrollment", async () => {
    const sequence = await seedActiveSequence(h, { steps: [EMAIL_STEP] })
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    const outcome = await h.service.executeStep(WS, enrollment.id, 0)
    expect(outcome.outcome).toBe("completed")
    const detail = await h.service.getEnrollment(memberCtx(), enrollment.id)
    expect(detail.enrollment.status).toBe("completed")
    expect(detail.enrollment.exitReason).toBe("completed")
    // Nothing further is scheduled.
    expect(h.enqueued.map((j) => j.stepIndex)).toEqual([0])
  })

  test("a wait step only schedules; it sends nothing", async () => {
    const sequence = await seedActiveSequence(h, {
      steps: [{ stepType: "wait", waitDays: 2 }, EMAIL_STEP],
    })
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    const outcome = await h.service.executeStep(WS, enrollment.id, 0)
    expect(outcome.outcome).toBe("executed")
    expect(h.emails).toHaveLength(0)
    expect(h.enqueued.map((j) => j.stepIndex)).toEqual([0, 1])
  })

  test("the delay before a step rides in the job, not in a sleep", async () => {
    const sequence = await seedActiveSequence(h)
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    await h.service.executeStep(WS, enrollment.id, 0)
    const followUp = h.enqueued.find((job) => job.stepIndex === 1)
    const threeDays = 3 * 24 * 60 * 60 * 1000
    const scheduled = (followUp?.runAt?.getTime() ?? 0) - Date.now()
    expect(scheduled).toBeGreaterThan(threeDays - 5_000)
    expect(scheduled).toBeLessThanOrEqual(threeDays + 5_000)
  })

  test("an enqueue failure is visible, not a silently stranded prospect", async () => {
    const broken = makeHarness({ queueThrows: true })
    const ctx = adminCtx()
    const sequence = await broken.service.create(ctx, {
      name: "Outbound v1",
      ownerId: "owner_member",
    })
    await broken.service.replaceSteps(ctx, sequence.id, { steps: [EMAIL_STEP, FOLLOW_UP_STEP] })
    await broken.service.setStatus(ctx, sequence.id, "active")
    await expect(
      broken.service.enroll(memberCtx(), sequence.id, { personId: "person_1" }),
    ).rejects.toThrow(/redis is down/)
  })
})

/* -------------------------- permission inheritance ------------------------- */

describe("sequences/permission-inheritance", () => {
  /**
   * A sequence is exactly as powerful as its owner is RIGHT NOW. Demote
   * the owner to viewer and the sequence stops being able to send —
   * without anybody editing the sequence.
   */
  test("a viewer-owned sequence does not send", async () => {
    const h = makeHarness()
    const sequence = await seedActiveSequence(h, { ownerId: "owner_viewer" })
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })

    const outcome = await h.service.executeStep(WS, enrollment.id, 0)
    expect(outcome.outcome).toBe("failed")
    expect(h.emails).toHaveLength(0)

    const detail = await h.service.getEnrollment(memberCtx(), enrollment.id)
    expect(detail.enrollment.status).toBe("failed")
    expect(detail.runs[0]?.status).toBe("failed")
    expect(String(detail.runs[0]?.error)).toMatch(/send_external/)
    expect(h.audits.some((a) => a.action === "step_failed")).toBe(true)
  })

  test("demoting the owner after activation stops the next send", async () => {
    const roles: Record<string, string> = { owner_member: "member" }
    const h = makeHarness({ roles })
    const sequence = await seedActiveSequence(h, { ownerId: "owner_member" })
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    await h.service.executeStep(WS, enrollment.id, 0)
    expect(h.emails).toHaveLength(1)

    // The owner is demoted. Nothing about the sequence changes.
    roles.owner_member = "viewer"

    const outcome = await h.service.executeStep(WS, enrollment.id, 1)
    expect(outcome.outcome).toBe("failed")
    expect(h.emails).toHaveLength(1)
  })

  test("a sequence whose owner left the workspace refuses to run", async () => {
    const h = makeHarness({ roles: {} })
    const sequence = await seedActiveSequence(h, { ownerId: "owner_gone" })
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    const outcome = await h.service.executeStep(WS, enrollment.id, 0)
    expect(outcome.outcome).toBe("failed")
    expect(String(outcome.error)).toMatch(/no longer a member/)
    expect(h.emails).toHaveLength(0)
  })

  test("a step executes as the OWNER, not as whoever enrolled the person", async () => {
    const h = makeHarness()
    const sequence = await seedActiveSequence(h, { ownerId: "owner_admin" })
    const { enrollment } = await h.service.enroll(memberCtx("enroller_1"), sequence.id, {
      personId: "person_1",
    })
    await h.service.executeStep(WS, enrollment.id, 0)
    expect(h.emails[0]?.ctx).toMatchObject({ actorId: "owner_admin", role: "admin" })
    expect(h.emails[0]?.ctx.correlationId).toBe(salesSequenceCorrelationId(enrollment.id))
  })

  test("personalisation renders known variables and blanks unknown ones", async () => {
    const h = makeHarness()
    const sequence = await seedActiveSequence(h, {
      steps: [{ ...EMAIL_STEP, subject: "Hi {{email}} / {{nope}}" }],
    })
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    await h.service.executeStep(WS, enrollment.id, 0)
    expect(h.emails[0]?.subject).toBe("Hi ada@example.com / ")
  })
})

/* --------------------------------- stats ----------------------------------- */

describe("sequences/stats", () => {
  test("per-enrollment and per-step counters come from the run table", async () => {
    const h = makeHarness()
    const sequence = await seedActiveSequence(h)
    const { enrollment } = await h.service.enroll(memberCtx(), sequence.id, {
      personId: "person_1",
    })
    await h.service.executeStep(WS, enrollment.id, 0)
    const stats = await h.service.stats(memberCtx(), sequence.id)
    expect(stats.enrollments).toHaveLength(1)
    expect(stats.steps).toEqual([
      { stepIndex: 0, stepType: "email", status: "succeeded", count: 1 },
    ])
  })

  test("stats for an unknown sequence is a NOT_FOUND, not an empty report", async () => {
    const h = makeHarness()
    await expect(h.service.stats(memberCtx(), "nope")).rejects.toThrow(/not found/)
  })
})

/* ------------------------------- store shape -------------------------------- */

describe("sequences/store-contract", () => {
  test("the fake honours the migration's two unique indexes", async () => {
    const { store } = createFakeSequenceStore()
    const draft: SalesSequenceStepDraft = { stepType: "email", config: {} }
    await store.replaceSteps(WS, "seq_1", [draft])

    const first = await store.enrollPerson(WS, {
      sequenceId: "seq_1",
      personId: "p1",
      emailAddress: "a@b.c",
    })
    const again = await store.enrollPerson(WS, {
      sequenceId: "seq_1",
      personId: "p1",
      emailAddress: "a@b.c",
    })
    expect(first.created).toBe(true)
    expect(again.created).toBe(false)

    const claim = await store.claimStepRun(WS, {
      enrollmentId: first.enrollment.id,
      stepIndex: 0,
      stepType: "email",
    })
    const reclaim = await store.claimStepRun(WS, {
      enrollmentId: first.enrollment.id,
      stepIndex: 0,
      stepType: "email",
    })
    expect(claim.claimed).toBe(true)
    expect(reclaim.claimed).toBe(false)
  })
})
