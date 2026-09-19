import { beforeEach, describe, expect, test } from "bun:test"
import { AiEvents } from "@yourcrm/events"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { nextId, resetIdCounter } from "@yourcrm/testing"
import { AiSelfApprovalError } from "./access"
import {
  createAiGovernanceService,
  AiActionAlreadyDecidedError,
  AiActionStateError,
  AI_GOVERNANCE_SERVICE_METHODS,
} from "./service"
import type {
  AiActionApplierPort,
  AiActionApprovalRecord,
  AiActionMutation,
  AiActionRequestRecord,
  AiGovernanceAuditInput,
  AiGovernanceServiceContext,
  AiGovernanceStore,
  AiPolicyRecord,
} from "./types"

/**
 * Hermetic tests for the five properties that ARE this module.
 *
 * The fake store reproduces the two database facts migration 0350 relies
 * on, because those facts are the guarantees:
 *
 *  - `ai_action_approvals_request_idx` UNIQUE (request_id): the approvals
 *    map is keyed on `requestId`, so a second decision reports
 *    `created: false` instead of overwriting.
 *  - claim-before-apply: `claimRequestApply` only hands out the row when
 *    the status is still `approved` and `applyClaimedAt` is unset, and
 *    sets it in the same step — the in-memory equivalent of the
 *    conditional UPDATE.
 *
 * No Postgres, no Redis, no HTTP.
 */

const WS = "ws-ai-gov"

type Harness = ReturnType<typeof makeHarness>

function makeHarness(options: {
  roles: Record<string, string>
  policies?: Partial<AiPolicyRecord>[]
  applyFails?: boolean
  revertFails?: boolean
}) {
  const requests = new Map<string, AiActionRequestRecord>()
  /** Keyed on requestId — this map IS the UNIQUE index. */
  const approvals = new Map<string, AiActionApprovalRecord>()
  const policies: AiPolicyRecord[] = (options.policies ?? []).map((p, i) => ({
    id: p.id ?? `policy-${i}`,
    workspaceId: WS,
    objectType: p.objectType ?? "*",
    action: p.action ?? "*",
    mode: p.mode ?? "require_approval",
    enabled: p.enabled ?? true,
    ...p,
  }))
  const audits: AiGovernanceAuditInput[] = []
  const emitted: { event: string; correlationId?: string; after?: unknown }[] = []
  const applies: { ctx: { actorId: string; role?: string }; mutation: AiActionMutation }[] = []
  const reverts: {
    ctx: { actorId: string; role?: string }
    mutation: AiActionMutation & { appliedRecordId: string | null }
  }[] = []

  const store: AiGovernanceStore = {
    listPolicies: async () => ({ data: policies, pagination: { nextCursor: null, limit: 25 } }),
    listActivePolicies: async () => policies.filter((p) => p.enabled !== false),
    findPolicyById: async (_ws, id) => policies.find((p) => p.id === id) ?? null,
    createPolicy: async (workspaceId, input) => {
      const policy: AiPolicyRecord = {
        id: nextId("policy"),
        workspaceId,
        objectType: String(input.objectType ?? "*"),
        action: String(input.action ?? "*"),
        mode: String(input.mode ?? "require_approval"),
        enabled: input.enabled !== false,
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
      // UNIQUE (request_id): one decision per request, forever.
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
    findApprovalByRequest: async (_ws, requestId) => {
      const found = approvals.get(requestId)
      return found ? { ...found } : null
    },
    claimRequestApply: async (workspaceId, id, claim) => {
      const row = requests.get(id)
      if (!row || row.workspaceId !== workspaceId) return { request: null, claimed: false }
      // The conditional UPDATE, in memory.
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
    applyAiAction: async (ctx, mutation) => {
      applies.push({ ctx, mutation })
      if (options.applyFails === true) throw new Error("the people service said no")
      return { recordId: mutation.recordId ?? nextId("record") }
    },
    revertAiAction: async (ctx, mutation) => {
      reverts.push({ ctx, mutation })
      if (options.revertFails === true) throw new Error("not reversible")
      return { recordId: mutation.appliedRecordId ?? nextId("record") }
    },
  }

  const service = createAiGovernanceService({
    store,
    applier,
    audit: async (input) => {
      audits.push(input)
    },
    events: {
      emit: async (event) => {
        emitted.push({
          event: event.event,
          ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
          after: event.after,
        })
      },
    },
    resolveActorRole: async (_ws, actorId) => options.roles[actorId] ?? null,
    now: () => new Date("2026-09-19T12:00:00.000Z"),
  })

  return {
    service,
    store,
    applier,
    audits,
    emitted,
    applies,
    reverts,
    requests,
    approvals,
    options,
  }
}

function ctxFor(actorId: string, role: string, extra: Partial<AiGovernanceServiceContext> = {}) {
  return {
    workspaceId: WS,
    actorId,
    role,
    correlationId: "req-corr-1",
    ...extra,
  } satisfies AiGovernanceServiceContext
}

const PROPOSAL = {
  objectType: "person",
  recordId: "person-1",
  action: "update" as const,
  before: { title: "CEO" },
  after: { title: "CTO" },
  rationale: "The signature block on their last email says CTO.",
  model: "claude-sonnet-4-6",
  runId: "run-42",
  agentId: "agent-hygiene",
}

async function propose(h: Harness, actorId: string, role: string) {
  const outcome = await h.service.requestAction(
    ctxFor(actorId, role, { actorType: "agent", agentId: "agent-hygiene" }),
    PROPOSAL,
  )
  return outcome
}

describe("ai-governance/service", () => {
  beforeEach(() => {
    resetIdCounter()
  })

  /* ------------------------------------------------------------------ */
  /* PROPERTY 1 — no privilege escalation                                */
  /* ------------------------------------------------------------------ */

  describe("property: no privilege escalation", () => {
    test("a viewer cannot approve a change a viewer could not make by hand", async () => {
      const h = makeHarness({ roles: { proposer: "member", reviewer: "viewer" } })
      const { request } = await propose(h, "proposer", "member")

      await expect(
        h.service.approve(ctxFor("reviewer", "viewer"), request.id, {}),
      ).rejects.toBeInstanceOf(PermissionDeniedError)
      // The gate is not cosmetic: nothing reached the domain service.
      expect(h.applies).toHaveLength(0)
      expect(h.requests.get(request.id)?.status).toBe("pending")
    })

    test("an owner cannot approve a proposal whose requester has since been demoted", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" } })
      const { request } = await propose(h, "proposer", "member")

      // The requester's LIVE role is re-read at decision time.
      h.options.roles.proposer = "viewer"

      await expect(
        h.service.approve(ctxFor("boss", "owner"), request.id, {}),
      ).rejects.toBeInstanceOf(PermissionDeniedError)
      expect(h.applies).toHaveLength(0)
    })

    test("a requester removed from the workspace is refused, not defaulted", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" } })
      const { request } = await propose(h, "proposer", "member")
      delete h.options.roles.proposer

      await expect(h.service.approve(ctxFor("boss", "owner"), request.id, {})).rejects.toThrow(
        "no longer a member",
      )
      expect(h.applies).toHaveLength(0)
    })

    test("an approver who could not perform the action is refused, however senior the requester", async () => {
      const h = makeHarness({ roles: { boss: "owner", colleague: "member" } })
      // An owner-backed agent proposes a delete; a member reviews it.
      const { request } = await h.service.requestAction(
        ctxFor("boss", "owner", { actorType: "agent" }),
        { ...PROPOSAL, action: "delete", after: undefined },
      )
      // `member` may not delete (foundation policy), so approving would
      // mean performing a delete the approver cannot perform by hand.
      await expect(
        h.service.approve(ctxFor("colleague", "member"), request.id, {}),
      ).rejects.toBeInstanceOf(PermissionDeniedError)
      expect(h.applies).toHaveLength(0)
    })

    test("a proposal the requester could not perform by hand never enters the queue", async () => {
      const h = makeHarness({ roles: { proposer: "member" } })
      await expect(
        h.service.requestAction(ctxFor("proposer", "member", { actorType: "agent" }), {
          ...PROPOSAL,
          action: "delete",
          after: undefined,
        }),
      ).rejects.toBeInstanceOf(PermissionDeniedError)
      expect(h.requests.size).toBe(0)
    })

    test("the applier runs as the REQUESTING actor with that actor's live role", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" } })
      const { request } = await propose(h, "proposer", "member")
      await h.service.approve(ctxFor("boss", "owner"), request.id, { reason: "checked the email" })

      expect(h.applies).toHaveLength(1)
      expect(h.applies[0]?.ctx.actorId).toBe("proposer")
      // Not "owner": approving does not lend the AI the approver's rights.
      expect(h.applies[0]?.ctx.role).toBe("member")
    })
  })

  /* ------------------------------------------------------------------ */
  /* PROPERTY 2 — self-approval is refused                               */
  /* ------------------------------------------------------------------ */

  describe("property: self-approval is refused", () => {
    test("the actor that requested an action cannot approve it", async () => {
      const h = makeHarness({ roles: { proposer: "owner" } })
      const { request } = await propose(h, "proposer", "owner")

      await expect(
        h.service.approve(ctxFor("proposer", "owner"), request.id, {}),
      ).rejects.toBeInstanceOf(AiSelfApprovalError)
      expect(h.applies).toHaveLength(0)
    })

    test("an AI actor can never approve anything, not even somebody else's request", async () => {
      const h = makeHarness({ roles: { proposer: "member", robot: "owner" } })
      const { request } = await propose(h, "proposer", "member")

      await expect(
        h.service.approve(ctxFor("robot", "owner", { actorType: "agent" }), request.id, {}),
      ).rejects.toThrow("an AI actor cannot approve")
      expect(h.applies).toHaveLength(0)
    })

    test("an AI actor can neither apply nor revert", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" } })
      const { request } = await propose(h, "proposer", "member")
      await h.service.approve(ctxFor("boss", "owner"), request.id, {})

      await expect(
        h.service.apply(ctxFor("robot", "owner", { actorType: "agent" }), request.id),
      ).rejects.toBeInstanceOf(AiSelfApprovalError)
      await expect(
        h.service.revert(ctxFor("robot", "owner", { actorType: "agent" }), request.id, {}),
      ).rejects.toBeInstanceOf(AiSelfApprovalError)
      expect(h.reverts).toHaveLength(0)
    })

    test("withdrawing your own proposal by rejecting it is allowed", async () => {
      const h = makeHarness({ roles: { proposer: "owner" } })
      const { request } = await propose(h, "proposer", "owner")
      const outcome = await h.service.reject(ctxFor("proposer", "owner"), request.id, {
        reason: "wrong person",
      })
      expect(outcome.request.status).toBe("rejected")
      expect(h.applies).toHaveLength(0)
    })
  })

  /* ------------------------------------------------------------------ */
  /* PROPERTY 3 — apply is exactly-once                                  */
  /* ------------------------------------------------------------------ */

  describe("property: apply is exactly-once", () => {
    test("approving twice applies once and the second call is refused", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner", other: "owner" } })
      const { request } = await propose(h, "proposer", "member")

      const first = await h.service.approve(ctxFor("boss", "owner"), request.id, {})
      expect(first.applied).toBe(true)

      // The ordinary double click is caught by the status guard; the true
      // concurrent race is caught by the UNIQUE index (next test). Either
      // way the mutation happens once.
      await expect(
        h.service.approve(ctxFor("other", "owner"), request.id, {}),
      ).rejects.toBeInstanceOf(AiActionStateError)
      expect(h.applies).toHaveLength(1)
    })

    test("a retried apply after a successful approval does nothing", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" } })
      const { request } = await propose(h, "proposer", "member")
      await h.service.approve(ctxFor("boss", "owner"), request.id, {})

      // The request is `applied` now, so `apply` refuses on state; force the
      // exact retry shape by calling the claim path again on an approved row.
      await expect(h.service.apply(ctxFor("boss", "owner"), request.id)).rejects.toBeInstanceOf(
        AiActionStateError,
      )
      expect(h.applies).toHaveLength(1)
    })

    test("two approvers racing on one request produce one application", async () => {
      const h = makeHarness({ roles: { proposer: "member", a: "owner", b: "owner" } })
      const { request } = await propose(h, "proposer", "member")

      const results = await Promise.allSettled([
        h.service.approve(ctxFor("a", "owner"), request.id, {}),
        h.service.approve(ctxFor("b", "owner"), request.id, {}),
      ])
      const fulfilled = results.filter((r) => r.status === "fulfilled")
      const rejected = results.filter((r) => r.status === "rejected")
      expect(fulfilled).toHaveLength(1)
      // The loser lost to the UNIQUE index on (request_id), not to a lock
      // this service is holding in memory.
      expect(rejected[0]?.status === "rejected" ? rejected[0].reason : null).toBeInstanceOf(
        AiActionAlreadyDecidedError,
      )
      expect(h.applies).toHaveLength(1)
      expect(h.approvals.size).toBe(1)
    })

    test("a lost claim reports applied:false instead of applying again", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" } })
      const { request } = await propose(h, "proposer", "member")
      // Auto-approve without applying, so `apply` has a legal target, then
      // steal the claim the way a crashed-and-retried worker would.
      await h.store.updateRequest(WS, request.id, { status: "approved" })
      await h.store.claimRequestApply(WS, request.id, {
        claimedBy: "worker-1",
        claimedAt: new Date(),
      })

      const outcome = await h.service.apply(ctxFor("boss", "owner"), request.id)
      expect(outcome.applied).toBe(false)
      expect(h.applies).toHaveLength(0)
    })

    test("reverting twice reverts once", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" } })
      const { request } = await propose(h, "proposer", "member")
      await h.service.approve(ctxFor("boss", "owner"), request.id, {})

      const first = await h.service.revert(ctxFor("boss", "owner"), request.id, {})
      expect(first.reverted).toBe(true)
      await expect(
        h.service.revert(ctxFor("boss", "owner"), request.id, {}),
      ).rejects.toBeInstanceOf(AiActionStateError)
      expect(h.reverts).toHaveLength(1)
    })

    test("a failed apply keeps its claim: no silent second attempt", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" }, applyFails: true })
      const { request } = await propose(h, "proposer", "member")

      await expect(h.service.approve(ctxFor("boss", "owner"), request.id, {})).rejects.toThrow(
        "the people service said no",
      )
      const stored = h.requests.get(request.id)
      expect(stored?.applyError).toBe("the people service said no")
      expect(stored?.applyClaimedAt).toBeDefined()
      // Retrying is refused rather than silently re-running the mutation.
      const retry = await h.store.claimRequestApply(WS, request.id, {
        claimedBy: "boss",
        claimedAt: new Date(),
      })
      expect(retry.claimed).toBe(false)
    })
  })

  /* ------------------------------------------------------------------ */
  /* PROPERTY 4 — everything is attributable                             */
  /* ------------------------------------------------------------------ */

  describe("property: everything is attributable", () => {
    test("request, approve, apply and revert each write an audit row with full attribution", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" } })
      const { request } = await propose(h, "proposer", "member")
      await h.service.approve(ctxFor("boss", "owner"), request.id, { reason: "verified" })
      await h.service.revert(ctxFor("boss", "owner"), request.id, { reason: "wrong title" })

      expect(h.audits.map((a) => a.action)).toEqual(["request", "approve", "apply", "revert"])
      for (const row of h.audits) {
        const after = row.after as Record<string, unknown>
        expect(row.source).toBe("ai")
        expect(row.object).toBe("ai_action_request")
        expect(row.recordId).toBe(request.id)
        expect(row.correlationId).toBe("req-corr-1")
        expect(after.model).toBe("claude-sonnet-4-6")
        expect(after.runId).toBe("run-42")
        expect(after.agentId).toBe("agent-hygiene")
        expect(after.actorId).toBe("proposer")
        expect(after.requestId).toBe(request.id)
      }
    })

    test("a request with no correlation id still gets one, derived from its own id", async () => {
      const h = makeHarness({ roles: { proposer: "member" } })
      const { request } = await h.service.requestAction(
        { workspaceId: WS, actorId: "proposer", role: "member", actorType: "agent" },
        PROPOSAL,
      )
      expect(h.audits[0]?.correlationId).toBe(`airq:${request.id}`)
    })

    test("the lifecycle emits the AiEvents constants", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" } })
      const { request } = await propose(h, "proposer", "member")
      await h.service.approve(ctxFor("boss", "owner"), request.id, {})
      await h.service.revert(ctxFor("boss", "owner"), request.id, {})

      expect(h.emitted.map((e) => e.event)).toEqual([
        AiEvents.ActionRequested,
        AiEvents.ActionApproved,
        AiEvents.ActionReverted,
      ])
      expect(h.emitted.every((e) => e.correlationId === "req-corr-1")).toBe(true)
    })

    test("a failed apply is recorded too — an AI change with no trail is a bug", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" }, applyFails: true })
      const { request } = await propose(h, "proposer", "member")
      await expect(h.service.approve(ctxFor("boss", "owner"), request.id, {})).rejects.toThrow()
      expect(h.audits.map((a) => a.action)).toEqual(["request", "approve", "apply_failed"])
    })
  })

  /* ------------------------------------------------------------------ */
  /* PROPERTY 5 — nothing bypasses the queue                             */
  /* ------------------------------------------------------------------ */

  describe("property: nothing bypasses the queue", () => {
    test("the public surface is exactly the frozen method list", () => {
      const h = makeHarness({ roles: {} })
      expect(Object.keys(h.service).sort()).toEqual([...AI_GOVERNANCE_SERVICE_METHODS])
    })

    test("a pending request cannot be applied", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" } })
      const { request } = await propose(h, "proposer", "member")
      await expect(h.service.apply(ctxFor("boss", "owner"), request.id)).rejects.toBeInstanceOf(
        AiActionStateError,
      )
      expect(h.applies).toHaveLength(0)
    })

    test("a rejected request can never be applied or approved afterwards", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" } })
      const { request } = await propose(h, "proposer", "member")
      await h.service.reject(ctxFor("boss", "owner"), request.id, { reason: "no" })

      await expect(h.service.apply(ctxFor("boss", "owner"), request.id)).rejects.toBeInstanceOf(
        AiActionStateError,
      )
      await expect(
        h.service.approve(ctxFor("boss", "owner"), request.id, {}),
      ).rejects.toBeInstanceOf(AiActionStateError)
      expect(h.applies).toHaveLength(0)
    })

    test("an expired request is refused and recorded as expired", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" } })
      const { request } = await h.service.requestAction(
        ctxFor("proposer", "member", { actorType: "agent" }),
        { ...PROPOSAL, expiresInMinutes: 1 },
      )
      // The harness clock is frozen; age the row instead.
      await h.store.updateRequest(WS, request.id, {
        expiresAt: new Date("2026-09-19T11:00:00.000Z"),
      })

      await expect(
        h.service.approve(ctxFor("boss", "owner"), request.id, {}),
      ).rejects.toBeInstanceOf(AiActionStateError)
      expect(h.requests.get(request.id)?.status).toBe("expired")
      expect(h.applies).toHaveLength(0)
    })

    test("only an applied request can be reverted", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" } })
      const { request } = await propose(h, "proposer", "member")
      await expect(
        h.service.revert(ctxFor("boss", "owner"), request.id, {}),
      ).rejects.toBeInstanceOf(AiActionStateError)
      expect(h.reverts).toHaveLength(0)
    })
  })

  /* ------------------------------------------------------------------ */
  /* policy modes                                                        */
  /* ------------------------------------------------------------------ */

  describe("policies", () => {
    test("with no policy configured, an AI write waits for a human", async () => {
      const h = makeHarness({ roles: { proposer: "member" } })
      const outcome = await propose(h, "proposer", "member")
      expect(outcome.mode).toBe("require_approval")
      expect(outcome.request.status).toBe("pending")
      expect(h.applies).toHaveLength(0)
    })

    test("a forbidden policy records the proposal as rejected and applies nothing", async () => {
      const h = makeHarness({
        roles: { proposer: "member" },
        policies: [{ objectType: "person", action: "update", mode: "forbidden" }],
      })
      const outcome = await propose(h, "proposer", "member")
      expect(outcome.mode).toBe("forbidden")
      expect(outcome.request.status).toBe("rejected")
      expect(h.applies).toHaveLength(0)
      // Still attributable: a refusal is part of the trail.
      expect(h.audits.map((a) => a.action)).toEqual(["request"])
    })

    test("an auto_apply policy applies inline, through the same claim", async () => {
      const h = makeHarness({
        roles: { proposer: "member" },
        policies: [{ objectType: "person", action: "update", mode: "auto_apply" }],
      })
      const outcome = await propose(h, "proposer", "member")
      expect(outcome.applied).toBe(true)
      expect(h.applies).toHaveLength(1)
      expect(h.requests.get(outcome.request.id)?.status).toBe("applied")
      expect(h.approvals.size).toBe(0)
    })

    test("auto_apply never escalates: the requester still needs the permission", async () => {
      const h = makeHarness({
        roles: { proposer: "member" },
        policies: [{ objectType: "person", action: "delete", mode: "auto_apply" }],
      })
      await expect(
        h.service.requestAction(ctxFor("proposer", "member", { actorType: "agent" }), {
          ...PROPOSAL,
          action: "delete",
          after: undefined,
        }),
      ).rejects.toBeInstanceOf(PermissionDeniedError)
      expect(h.applies).toHaveLength(0)
    })

    test("writing policy is admin-only", async () => {
      const h = makeHarness({ roles: { member: "member" } })
      await expect(
        h.service.createPolicy(ctxFor("member", "member"), {
          objectType: "person",
          action: "update",
          mode: "auto_apply",
        }),
      ).rejects.toBeInstanceOf(PermissionDeniedError)
    })

    test("a viewer cannot even propose: run_ai is checked first", async () => {
      const h = makeHarness({ roles: { watcher: "viewer" } })
      await expect(
        h.service.requestAction(ctxFor("watcher", "viewer", { actorType: "agent" }), PROPOSAL),
      ).rejects.toBeInstanceOf(PermissionDeniedError)
      expect(h.requests.size).toBe(0)
    })
  })

  /* ------------------------------------------------------------------ */
  /* the proposal contract                                               */
  /* ------------------------------------------------------------------ */

  describe("the proposal contract", () => {
    test("a proposal without a rationale is rejected at the boundary", async () => {
      const h = makeHarness({ roles: { proposer: "member" } })
      await expect(
        h.service.requestAction(ctxFor("proposer", "member", { actorType: "agent" }), {
          ...PROPOSAL,
          rationale: "   ",
        }),
      ).rejects.toThrow()
    })

    test("an update must carry the state it read, so it can be reverted", async () => {
      const h = makeHarness({ roles: { proposer: "member" } })
      await expect(
        h.service.requestAction(ctxFor("proposer", "member", { actorType: "agent" }), {
          ...PROPOSAL,
          before: undefined,
        }),
      ).rejects.toThrow()
    })

    test("revert hands the applier the recorded before-state", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" } })
      const { request } = await propose(h, "proposer", "member")
      await h.service.approve(ctxFor("boss", "owner"), request.id, {})
      await h.service.revert(ctxFor("boss", "owner"), request.id, {})

      expect(h.reverts[0]?.mutation.before).toEqual({ title: "CEO" })
      expect(h.reverts[0]?.mutation.appliedRecordId).toBe("person-1")
    })

    test("the queue lists what is waiting for a human", async () => {
      const h = makeHarness({ roles: { proposer: "member", boss: "owner" } })
      await propose(h, "proposer", "member")
      const listed = await h.service.listRequests(ctxFor("boss", "owner"), { status: "pending" })
      expect(listed.data).toHaveLength(1)
      expect(listed.pagination.limit).toBe(25)
    })
  })
})
