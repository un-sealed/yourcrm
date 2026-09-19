import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createAiGovernanceService,
  type AiActionApplierPort,
  type AiActionApprovalRecord,
  type AiActionMutation,
  type AiActionRequestRecord,
  type AiGovernanceAuditInput,
  type AiGovernanceService,
  type AiGovernanceStore,
  type AiPolicyRecord,
} from "@yourcrm/crm/src/ai-governance"
import { createApiClient, makeSession, nextId, resetIdCounter } from "@yourcrm/testing"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./ai-governance"

/**
 * Hermetic API test: the route factory takes a service, so this injects
 * the REAL domain service over an in-memory store that reproduces the two
 * database guarantees from migration 0350 — the UNIQUE index on
 * `ai_action_approvals (request_id)` and the claim-before-apply
 * conditional UPDATE. No Postgres, no Redis.
 *
 * What is under test here is the HTTP contract of the gate: that a
 * refusal is a 403 and not a 500, that a second approval is a 409, and
 * that no route exists through which an AI write reaches a record without
 * an approved request.
 */

const WS = "ws-ai-governance"

const PROPOSAL = {
  objectType: "person",
  recordId: "person-1",
  action: "update",
  before: { title: "CEO" },
  after: { title: "CTO" },
  rationale: "Their email signature says CTO.",
  model: "claude-sonnet-4-6",
  runId: "run-7",
}

function makeFake(options: { roles: Record<string, string>; policies?: AiPolicyRecord[] }) {
  const requests = new Map<string, AiActionRequestRecord>()
  const approvals = new Map<string, AiActionApprovalRecord>()
  const policies: AiPolicyRecord[] = options.policies ?? []
  const audits: AiGovernanceAuditInput[] = []
  const applied: AiActionMutation[] = []
  const reverted: AiActionMutation[] = []

  const store: AiGovernanceStore = {
    listPolicies: async () => ({ data: policies, pagination: { nextCursor: null, limit: 25 } }),
    listActivePolicies: async () => policies,
    findPolicyById: async (_ws, id) => policies.find((p) => p.id === id) ?? null,
    createPolicy: async (workspaceId, input) => {
      const policy: AiPolicyRecord = {
        id: nextId("policy"),
        workspaceId,
        objectType: String(input.objectType ?? "*"),
        action: String(input.action ?? "*"),
        mode: String(input.mode ?? "require_approval"),
      }
      policies.push(policy)
      return policy
    },
    updatePolicy: async (_ws, id, input) => {
      const found = policies.find((p) => p.id === id)
      if (!found) return null
      Object.assign(found, input)
      return found
    },
    softDeletePolicy: async (_ws, id) => {
      const index = policies.findIndex((p) => p.id === id)
      if (index >= 0) policies.splice(index, 1)
    },
    listRequests: async (workspaceId, query) => {
      let rows = [...requests.values()].filter((r) => r.workspaceId === workspaceId)
      if (query.status !== undefined) rows = rows.filter((r) => r.status === query.status)
      const limit = query.limit ?? 25
      return { data: rows.slice(0, limit), pagination: { nextCursor: null, limit } }
    },
    findRequestById: async (workspaceId, id) => {
      const row = requests.get(id)
      return row && row.workspaceId === workspaceId ? { ...row } : null
    },
    createRequest: async (workspaceId, input) => {
      const request: AiActionRequestRecord = {
        ...input,
        id: nextId("airq"),
        workspaceId,
        actorId: String(input.actorId),
        objectType: String(input.objectType),
        action: String(input.action),
        status: String(input.status ?? "pending"),
      }
      requests.set(request.id, request)
      return { ...request }
    },
    updateRequest: async (workspaceId, id, patch) => {
      const row = requests.get(id)
      if (!row || row.workspaceId !== workspaceId) return null
      const next = { ...row, ...patch, status: String(patch.status ?? row.status) }
      requests.set(id, next)
      return { ...next }
    },
    recordDecision: async (workspaceId, input) => {
      const requestId = String(input.requestId)
      const existing = approvals.get(requestId)
      if (existing) return { approval: { ...existing }, created: false }
      const approval: AiActionApprovalRecord = {
        ...input,
        id: nextId("aiap"),
        workspaceId,
        requestId,
        decision: String(input.decision),
        approverId: String(input.approverId),
      }
      approvals.set(requestId, approval)
      return { approval: { ...approval }, created: true }
    },
    findApprovalByRequest: async (_ws, requestId) => approvals.get(requestId) ?? null,
    claimRequestApply: async (workspaceId, id, claim) => {
      const row = requests.get(id)
      if (!row || row.workspaceId !== workspaceId) return { request: null, claimed: false }
      if (row.status !== "approved" || row.applyClaimedAt != null) {
        return { request: { ...row }, claimed: false }
      }
      const next = { ...row, applyClaimedAt: claim.claimedAt, applyClaimedBy: claim.claimedBy }
      requests.set(id, next)
      return { request: { ...next }, claimed: true }
    },
    claimRequestRevert: async (workspaceId, id, claim) => {
      const row = requests.get(id)
      if (!row || row.workspaceId !== workspaceId) return { request: null, claimed: false }
      if (row.status !== "applied" || row.revertClaimedAt != null) {
        return { request: { ...row }, claimed: false }
      }
      const next = { ...row, revertClaimedAt: claim.claimedAt, revertClaimedBy: claim.claimedBy }
      requests.set(id, next)
      return { request: { ...next }, claimed: true }
    },
  }

  const applier: AiActionApplierPort = {
    applyAiAction: async (_ctx, mutation) => {
      applied.push(mutation)
      return { recordId: mutation.recordId ?? nextId("record") }
    },
    revertAiAction: async (_ctx, mutation) => {
      reverted.push(mutation)
      return { recordId: mutation.appliedRecordId ?? nextId("record") }
    },
  }

  const service = createAiGovernanceService({
    store,
    applier,
    audit: async (input) => {
      audits.push(input)
    },
    events: { emit: async () => {} },
    resolveActorRole: async (_ws, actorId) => options.roles[actorId] ?? null,
  })

  return { service, store, audits, applied, reverted, requests, approvals }
}

function makeTestApp(session: { current: Session | null }, service: AiGovernanceService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    // Mirrors the request-id middleware: audit rows correlate with logs.
    const requestId = c.req.header("x-request-id")
    if (requestId !== undefined) c.set("requestId", requestId)
    await next()
  })
  app.route("/api/v1/ai/governance", createRoutes({ service }))
  return app
}

describe("api/ai-governance", () => {
  let session: { current: Session | null }
  let fake: ReturnType<typeof makeFake>
  let owner: Session
  let member: Session
  let viewer: Session

  beforeEach(() => {
    resetIdCounter()
    // Everyone shares one workspace so the queue is the same queue.
    owner = makeSession({ role: "owner", workspaceId: WS })
    member = makeSession({ role: "member", workspaceId: WS })
    viewer = makeSession({ role: "viewer", workspaceId: WS })
    session = { current: member }
    fake = makeFake({
      roles: {
        [owner.user.id]: "owner",
        [member.user.id]: "member",
        [viewer.user.id]: "viewer",
      },
    })
  })

  const client = () => createApiClient({ app: makeTestApp(session, fake.service) })

  async function proposeAsMember() {
    session.current = member
    const res = await client().post("/api/v1/ai/governance/requests", PROPOSAL)
    expect(res.status).toBe(201)
    return res.expectSuccess().data as { id: string; status: string }
  }

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const res = await client().get("/api/v1/ai/governance/requests")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("a proposal is recorded as pending and applies nothing", async () => {
    const request = await proposeAsMember()
    expect(request.status).toBe("pending")
    expect(fake.applied).toHaveLength(0)
  })

  test("a proposal without a rationale is a 400, not a 500", async () => {
    session.current = member
    const res = await client().post("/api/v1/ai/governance/requests", {
      ...PROPOSAL,
      rationale: "",
    })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("the queue returns the cursor pagination envelope", async () => {
    await proposeAsMember()
    const res = await client().get("/api/v1/ai/governance/requests?status=pending")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("the catalogue is served before the :id route and names the bound objects", async () => {
    session.current = member
    const res = await client().get("/api/v1/ai/governance/catalogue")
    expect(res.status).toBe(200)
    const data = res.expectSuccess().data as {
      actions: string[]
      statuses: string[]
      appliableObjects: string[]
    }
    expect(data.actions).toEqual(["create", "update", "delete", "send_external"])
    expect(data.statuses).toContain("reverted")
    expect(data.appliableObjects).toContain("person")
  })

  /* ------------------------------ the properties ----------------------------- */

  test("self-approval over HTTP is a 403 and applies nothing", async () => {
    const request = await proposeAsMember()
    const res = await client().post(`/api/v1/ai/governance/requests/${request.id}/approve`, {})
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
    expect(fake.applied).toHaveLength(0)
  })

  test("a viewer cannot approve what a viewer could not do by hand", async () => {
    const request = await proposeAsMember()
    session.current = viewer
    const res = await client().post(`/api/v1/ai/governance/requests/${request.id}/approve`, {})
    expect(res.status).toBe(403)
    expect(fake.applied).toHaveLength(0)
  })

  test("an approval by somebody else applies exactly once", async () => {
    const request = await proposeAsMember()
    session.current = owner
    const first = await client().post(`/api/v1/ai/governance/requests/${request.id}/approve`, {
      reason: "checked it",
    })
    expect(first.status).toBe(200)
    expect((first.expectSuccess().data as { applied: boolean }).applied).toBe(true)
    expect(fake.applied).toHaveLength(1)

    const second = await client().post(`/api/v1/ai/governance/requests/${request.id}/approve`, {})
    expect(second.status).toBe(409)
    second.expectError("CONFLICT")
    expect(fake.applied).toHaveLength(1)
  })

  test("applying an approved request twice applies once", async () => {
    const request = await proposeAsMember()
    await fake.store.updateRequest(WS, request.id, { status: "approved" })
    session.current = owner

    const first = await client().post(`/api/v1/ai/governance/requests/${request.id}/apply`, {})
    expect((first.expectSuccess().data as { applied: boolean }).applied).toBe(true)
    const second = await client().post(`/api/v1/ai/governance/requests/${request.id}/apply`, {})
    expect(second.status).toBe(409)
    expect(fake.applied).toHaveLength(1)
  })

  test("a pending request cannot be applied through any route", async () => {
    const request = await proposeAsMember()
    session.current = owner
    const res = await client().post(`/api/v1/ai/governance/requests/${request.id}/apply`, {})
    expect(res.status).toBe(409)
    expect(fake.applied).toHaveLength(0)
  })

  test("rejecting needs a reason and closes the request", async () => {
    const request = await proposeAsMember()
    session.current = owner
    const bad = await client().post(`/api/v1/ai/governance/requests/${request.id}/reject`, {})
    expect(bad.status).toBe(400)

    const res = await client().post(`/api/v1/ai/governance/requests/${request.id}/reject`, {
      reason: "the signature is out of date",
    })
    expect(res.status).toBe(200)
    expect((res.expectSuccess().data as { status: string }).status).toBe("rejected")
    expect(fake.applied).toHaveLength(0)
  })

  test("revert restores the recorded before-state and is recorded", async () => {
    const request = await proposeAsMember()
    session.current = owner
    await client().post(`/api/v1/ai/governance/requests/${request.id}/approve`, {})
    const res = await client().post(`/api/v1/ai/governance/requests/${request.id}/revert`, {
      reason: "wrong",
    })
    expect(res.status).toBe(200)
    expect(fake.reverted[0]?.before).toEqual({ title: "CEO" })
    expect(fake.audits.map((a) => a.action)).toEqual(["request", "approve", "apply", "revert"])
    expect(fake.audits.every((a) => a.source === "ai")).toBe(true)
  })

  test("every audit row carries the correlation id the request arrived with", async () => {
    session.current = member
    const res = await client().post("/api/v1/ai/governance/requests", PROPOSAL, {
      headers: { "x-request-id": "corr-abc" },
    })
    expect(res.status).toBe(201)
    expect(fake.audits[0]?.correlationId).toBe("corr-abc")
    const after = fake.audits[0]?.after as Record<string, unknown>
    expect(after.model).toBe("claude-sonnet-4-6")
    expect(after.runId).toBe("run-7")
  })

  test("a detail view shows the diff and the decision", async () => {
    const request = await proposeAsMember()
    session.current = owner
    await client().post(`/api/v1/ai/governance/requests/${request.id}/approve`, {
      reason: "verified",
    })
    const res = await client().get(`/api/v1/ai/governance/requests/${request.id}`)
    const data = res.expectSuccess().data as {
      before: unknown
      after: unknown
      approval: { decision: string; reason: string } | null
    }
    expect(data.before).toEqual({ title: "CEO" })
    expect(data.after).toEqual({ title: "CTO" })
    expect(data.approval?.decision).toBe("approved")
  })

  test("an unknown request is a 404", async () => {
    session.current = owner
    const res = await client().get("/api/v1/ai/governance/requests/nope")
    expect(res.status).toBe(404)
    res.expectError("NOT_FOUND")
  })

  /* --------------------------------- policies -------------------------------- */

  test("only an admin may write policy", async () => {
    session.current = member
    const denied = await client().post("/api/v1/ai/governance/policies", {
      objectType: "person",
      action: "update",
      mode: "auto_apply",
    })
    expect(denied.status).toBe(403)

    session.current = owner
    const created = await client().post("/api/v1/ai/governance/policies", {
      objectType: "person",
      action: "update",
      mode: "auto_apply",
    })
    expect(created.status).toBe(201)
  })

  test("an unknown policy mode is a 400", async () => {
    session.current = owner
    const res = await client().post("/api/v1/ai/governance/policies", {
      objectType: "person",
      action: "update",
      mode: "whatever",
    })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("an auto_apply policy applies at proposal time, still audited", async () => {
    session.current = owner
    await client().post("/api/v1/ai/governance/policies", {
      objectType: "person",
      action: "update",
      mode: "auto_apply",
    })
    session.current = member
    const res = await client().post("/api/v1/ai/governance/requests", PROPOSAL)
    expect(res.status).toBe(201)
    expect((res.expectSuccess().data as { applied: boolean }).applied).toBe(true)
    expect(fake.applied).toHaveLength(1)
    expect(
      fake.audits.filter((a) => a.object === "ai_action_request").map((a) => a.action),
    ).toEqual(["request", "apply"])
  })

  test("a forbidden policy records the proposal as rejected without applying", async () => {
    session.current = owner
    await client().post("/api/v1/ai/governance/policies", {
      objectType: "person",
      action: "update",
      mode: "forbidden",
    })
    session.current = member
    const res = await client().post("/api/v1/ai/governance/requests", PROPOSAL)
    expect(res.status).toBe(201)
    expect((res.expectSuccess().data as { status: string }).status).toBe("rejected")
    expect(fake.applied).toHaveLength(0)
  })
})
