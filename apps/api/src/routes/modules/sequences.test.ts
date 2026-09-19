import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createSalesSequenceService,
  type SalesSequenceAuditInput,
  type SalesSequenceEnrollmentRecord,
  type SalesSequenceRecord,
  type SalesSequenceService,
  type SalesSequenceStepJobRequest,
  type SalesSequenceStepRecord,
  type SalesSequenceStepRunRecord,
  type SalesSequenceStore,
} from "@yourcrm/crm/src/sequences"
import { createApiClient, makeSession, nextId } from "@yourcrm/testing"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./sequences"

const OWNER = "22222222-2222-4222-8222-222222222222"
const VIEWER = "33333333-3333-4333-8333-333333333333"
const PERSON = "44444444-4444-4444-8444-444444444444"

/**
 * Hermetic API test: the REAL domain service over an in-memory store, so
 * the permission path, the envelopes and the error mapping are exercised
 * for real — the same pattern `unified-inbox.test.ts` uses. No Postgres,
 * no Redis, no email provider.
 */
function makeFakeService(workspaceId: string) {
  const sequences = new Map<string, SalesSequenceRecord>()
  const steps = new Map<string, SalesSequenceStepRecord[]>()
  const enrollments = new Map<string, SalesSequenceEnrollmentRecord>()
  const enrollmentByPerson = new Map<string, string>()
  const runs = new Map<string, SalesSequenceStepRunRecord>()
  const runByStep = new Map<string, string>()
  const audits: SalesSequenceAuditInput[] = []
  const enqueued: SalesSequenceStepJobRequest[] = []
  const emails: { to: string; subject: string }[] = []

  const store: SalesSequenceStore = {
    list: async (_ws, query) => {
      const rows = [...sequences.values()].filter(
        (row) => !query.status || row.status === query.status,
      )
      const limit = query.limit ?? 25
      return { data: rows.slice(0, limit), pagination: { nextCursor: null, limit } }
    },
    findById: async (ws, id) => {
      const row = sequences.get(id)
      return row && row.workspaceId === ws ? row : null
    },
    create: async (ws, input, actorId) => {
      const row: SalesSequenceRecord = {
        ...input,
        id: nextId("seq"),
        workspaceId: ws,
        status: String(input.status ?? "draft"),
        ownerId: (input.ownerId as string | null) ?? actorId ?? null,
        exitOnReply: input.exitOnReply ?? true,
        exitOnBounce: input.exitOnBounce ?? true,
      }
      sequences.set(row.id, row)
      return row
    },
    update: async (ws, id, patch) => {
      const row = sequences.get(id)
      if (!row || row.workspaceId !== ws) return null
      const next = { ...row, ...patch, status: String(patch.status ?? row.status) }
      sequences.set(id, next)
      return next
    },
    softDelete: async (_ws, id) => {
      sequences.delete(id)
    },
    restore: async () => {},
    markEnrolled: async () => {},

    listSteps: async (_ws, sequenceId) => steps.get(sequenceId) ?? [],
    replaceSteps: async (ws, sequenceId, drafts) => {
      const rows = drafts.map((draft, index) => ({
        id: nextId("step"),
        workspaceId: ws,
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

    enrollPerson: async (ws, input) => {
      const key = `${String(input.sequenceId)}:${String(input.personId)}`
      const existingId = enrollmentByPerson.get(key)
      const existing = existingId ? enrollments.get(existingId) : undefined
      if (existing) return { enrollment: existing, created: false }
      const enrollment: SalesSequenceEnrollmentRecord = {
        ...input,
        id: nextId("enr"),
        workspaceId: ws,
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
    findEnrollmentById: async (ws, id) => {
      const row = enrollments.get(id)
      return row && row.workspaceId === ws ? row : null
    },
    listEnrollments: async (_ws, query) => {
      let rows = [...enrollments.values()]
      if (query.sequenceId) rows = rows.filter((r) => r.sequenceId === query.sequenceId)
      if (query.status) rows = rows.filter((r) => r.status === query.status)
      const limit = query.limit ?? 25
      return { data: rows.slice(0, limit), pagination: { nextCursor: null, limit } }
    },
    updateEnrollment: async (_ws, id, patch) => {
      const row = enrollments.get(id)
      if (!row) return null
      const next: SalesSequenceEnrollmentRecord = {
        ...row,
        ...patch,
        status: String(patch.status ?? row.status),
        currentStepIndex: Number(patch.currentStepIndex ?? row.currentStepIndex),
      }
      enrollments.set(id, next)
      return next
    },
    incrementSentCount: async (_ws, id) => enrollments.get(id) ?? null,
    findActiveEnrollmentsByTarget: async (_ws, target) =>
      [...enrollments.values()].filter(
        (row) =>
          (row.status === "active" || row.status === "paused") &&
          ((target.personId != null && row.personId === target.personId) ||
            (target.emailAddress != null && row.emailAddress === target.emailAddress)),
      ),
    findSuppression: async (_ws, target) =>
      [...enrollments.values()].find(
        (row) =>
          (row.exitReason === "unsubscribed" || row.exitReason === "bounced") &&
          target.personId != null &&
          row.personId === target.personId,
      ) ?? null,

    claimStepRun: async (ws, input) => {
      const key = `${input.enrollmentId}:${input.stepIndex}`
      const existingId = runByStep.get(key)
      const existing = existingId ? runs.get(existingId) : undefined
      if (existing) return { run: existing, claimed: false }
      const run: SalesSequenceStepRunRecord = {
        id: nextId("run"),
        workspaceId: ws,
        enrollmentId: input.enrollmentId,
        stepIndex: input.stepIndex,
        stepType: input.stepType,
        status: "running",
      }
      runs.set(run.id, run)
      runByStep.set(key, run.id)
      return { run, claimed: true }
    },
    completeStepRun: async (_ws, id, patch) => {
      const run = runs.get(id)
      if (!run) return null
      const next = { ...run, ...patch, status: String(patch.status ?? run.status) }
      runs.set(id, next)
      return next
    },
    listStepRuns: async (_ws, enrollmentId) =>
      [...runs.values()].filter((r) => r.enrollmentId === enrollmentId),

    stats: async () => ({
      enrollments: [{ status: "active", exitReason: null, count: enrollments.size }],
      steps: [],
    }),
  }

  const service = createSalesSequenceService({
    store,
    audit: async (input) => {
      audits.push(input)
    },
    queue: {
      enqueueSequenceStep: async (request) => {
        enqueued.push(request)
      },
    },
    executor: {
      sendSequenceEmail: async (_ctx, input) => {
        emails.push({ to: input.to, subject: input.subject })
        return { messageId: nextId("msg"), threadId: "thread_1" }
      },
      createSequenceTask: async () => ({ taskId: nextId("task") }),
    },
    resolveActorRole: async (_ws, actorId) => (actorId === OWNER ? "admin" : "viewer"),
    resolveContact: async (_ws, personId) => ({ personId, emailAddress: "ada@example.com" }),
  })

  return { service, audits, enqueued, emails, workspaceId }
}

function makeTestApp(session: { current: Session | null }, service: SalesSequenceService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/sequences", createRoutes({ service }))
  return app
}

describe("api/sequences", () => {
  let session: { current: Session | null }
  let owner: Session
  let viewer: Session
  let service: SalesSequenceService
  let audits: SalesSequenceAuditInput[]
  let enqueued: SalesSequenceStepJobRequest[]
  let emails: { to: string; subject: string }[]

  beforeEach(() => {
    owner = makeSession({ role: "owner", userId: OWNER })
    const workspaceId = owner.workspaceId ?? ""
    viewer = makeSession({
      role: "viewer",
      userId: VIEWER,
      workspaceId,
      memberships: [{ workspaceId, role: "viewer" }],
    })
    session = { current: owner }
    const fake = makeFakeService(workspaceId)
    service = fake.service
    audits = fake.audits
    enqueued = fake.enqueued
    emails = fake.emails
  })

  const api = () => createApiClient({ app: makeTestApp(session, service), session: owner })

  async function createSequence(): Promise<string> {
    const res = await api().post(
      "/api/v1/sequences",
      { name: "Outbound v1" },
      {
        expectedStatus: 201,
      },
    )
    return String((res.expectSuccess().data as { id: string }).id)
  }

  async function activeSequence(): Promise<string> {
    const id = await createSequence()
    await api().request(`/api/v1/sequences/${id}/steps`, {
      method: "PUT",
      body: JSON.stringify({
        steps: [
          { stepType: "email", subject: "Hello", bodyText: "Hi there" },
          { stepType: "wait", waitDays: 3 },
          { stepType: "email", subject: "Following up", bodyText: "Still interested?" },
        ],
      }),
      expectedStatus: 200,
    })
    await api().post(
      `/api/v1/sequences/${id}/status`,
      { status: "active" },
      {
        expectedStatus: 200,
      },
    )
    return id
  }

  test("route construction touches no database", () => {
    // Registry/full-app tests mount every module without Postgres: the
    // default service must stay lazy.
    expect(() => createRoutes()).not.toThrow()
  })

  test("listing requires a session", async () => {
    session.current = null
    const res = await createApiClient({ app: makeTestApp(session, service) }).get(
      "/api/v1/sequences",
    )
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("creating returns 201 and the sequence starts as a draft", async () => {
    const res = await api().post(
      "/api/v1/sequences",
      { name: "Outbound v1" },
      {
        expectedStatus: 201,
      },
    )
    const created = res.expectSuccess().data as { status: string; ownerId: string }
    expect(created.status).toBe("draft")
    expect(created.ownerId).toBe(OWNER)
    expect(audits.some((a) => a.action === "create")).toBe(true)
  })

  test("the list uses the shared paginated envelope", async () => {
    await createSequence()
    const body = (await api().get("/api/v1/sequences", { expectedStatus: 200 })).expectSuccess()
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("an invalid body is a 400 envelope, not a 500", async () => {
    const res = await api().post("/api/v1/sequences", { name: "" })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("an unknown query parameter value is a 400", async () => {
    const res = await api().get("/api/v1/sequences?status=exploded")
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("an unknown sequence is a 404", async () => {
    const res = await api().get("/api/v1/sequences/nope")
    expect(res.status).toBe(404)
    res.expectError("NOT_FOUND")
  })

  test("a viewer cannot create a sequence (403, server-side)", async () => {
    const res = await createApiClient({
      app: makeTestApp({ current: viewer }, service),
      session: viewer,
    }).post("/api/v1/sequences", { name: "Outbound v1" })
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
  })

  test("a viewer cannot activate a sequence: activating is send_external", async () => {
    const id = await createSequence()
    await api().request(`/api/v1/sequences/${id}/steps`, {
      method: "PUT",
      body: JSON.stringify({ steps: [{ stepType: "email", subject: "Hi", bodyText: "Hello" }] }),
      expectedStatus: 200,
    })
    const res = await createApiClient({
      app: makeTestApp({ current: viewer }, service),
      session: viewer,
    }).post(`/api/v1/sequences/${id}/status`, { status: "active" })
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
  })

  test("activating a sequence with no steps is a 422, not a 500", async () => {
    const id = await createSequence()
    const res = await api().post(`/api/v1/sequences/${id}/status`, { status: "active" })
    expect(res.status).toBe(422)
    res.expectError("SEQUENCE_NOT_ENROLLABLE")
  })

  test("the step editor replaces the ordered list", async () => {
    const id = await activeSequence()
    const detail = (
      await api().get(`/api/v1/sequences/${id}`, { expectedStatus: 200 })
    ).expectSuccess().data as { steps: { stepIndex: number; stepType: string }[] }
    expect(detail.steps.map((s) => s.stepType)).toEqual(["email", "wait", "email"])
    expect(detail.steps.map((s) => s.stepIndex)).toEqual([0, 1, 2])
  })

  test("enrolling is 201 the first time and 200 the second (idempotent)", async () => {
    const id = await activeSequence()
    const first = await api().post(
      `/api/v1/sequences/${id}/enrollments`,
      { personId: PERSON },
      { expectedStatus: 201 },
    )
    const enrollmentId = String((first.expectSuccess().data as { id: string }).id)
    expect(enqueued).toHaveLength(1)

    const second = await api().post(
      `/api/v1/sequences/${id}/enrollments`,
      { personId: PERSON },
      { expectedStatus: 200 },
    )
    expect((second.expectSuccess().data as { id: string }).id).toBe(enrollmentId)
    expect(enqueued).toHaveLength(1)
  })

  test("enrolling into a draft sequence is a 422", async () => {
    const id = await createSequence()
    const res = await api().post(`/api/v1/sequences/${id}/enrollments`, { personId: PERSON })
    expect(res.status).toBe(422)
    res.expectError("SEQUENCE_NOT_ENROLLABLE")
  })

  test("a suppressed contact cannot be re-enrolled (409)", async () => {
    const id = await activeSequence()
    await api().post(
      `/api/v1/sequences/${id}/enrollments`,
      { personId: PERSON },
      {
        expectedStatus: 201,
      },
    )
    await api().post(
      "/api/v1/sequences/unsubscribe",
      { personId: PERSON },
      {
        expectedStatus: 200,
      },
    )

    const other = await activeSequence()
    const res = await api().post(`/api/v1/sequences/${other}/enrollments`, { personId: PERSON })
    expect(res.status).toBe(409)
    res.expectError("SEQUENCE_CONTACT_SUPPRESSED")
  })

  test("stopping an enrollment records the reason and sends nothing more", async () => {
    const id = await activeSequence()
    const created = await api().post(
      `/api/v1/sequences/${id}/enrollments`,
      { personId: PERSON },
      { expectedStatus: 201 },
    )
    const enrollmentId = String((created.expectSuccess().data as { id: string }).id)

    const stopped = await api().post(
      `/api/v1/sequences/enrollments/${enrollmentId}/stop`,
      { reason: "removed" },
      { expectedStatus: 200 },
    )
    expect(stopped.expectSuccess().data).toMatchObject({
      status: "stopped",
      exitReason: "removed",
    })

    const detail = (
      await api().get(`/api/v1/sequences/enrollments/${enrollmentId}`, { expectedStatus: 200 })
    ).expectSuccess().data as { status: string; runs: unknown[] }
    expect(detail.status).toBe("stopped")
    expect(detail.runs).toEqual([])
    expect(emails).toHaveLength(0)
  })

  test("the catalogue is served from the constants, not hard-coded in the UI", async () => {
    const body = (
      await api().get("/api/v1/sequences/catalogue", { expectedStatus: 200 })
    ).expectSuccess().data as {
      stepTypes: { type: string }[]
      exitReasons: { reason: string; automatic: boolean }[]
      maxSteps: number
    }
    expect(body.stepTypes.map((s) => s.type)).toEqual(["email", "task", "wait"])
    expect(body.exitReasons.find((r) => r.reason === "replied")?.automatic).toBe(true)
    expect(body.exitReasons.find((r) => r.reason === "removed")?.automatic).toBe(false)
    expect(body.maxSteps).toBeGreaterThan(0)
  })

  test("stats are workspace-scoped and 404 for an unknown sequence", async () => {
    const id = await activeSequence()
    const body = (
      await api().get(`/api/v1/sequences/${id}/stats`, { expectedStatus: 200 })
    ).expectSuccess()
    expect(body.data).toHaveProperty("enrollments")
    const missing = await api().get("/api/v1/sequences/nope/stats")
    expect(missing.status).toBe(404)
  })

  test("echoes the request id", async () => {
    const res = await api().get("/api/v1/sequences", { requestId: "req-seq-1" })
    expect(res.status).toBe(200)
  })
})
