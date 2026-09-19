import { beforeEach, describe, expect, test } from "bun:test"
import { AiEvents } from "@yourcrm/events"
import { expectDenied, makeServiceContext, nextId, resetIdCounter } from "@yourcrm/testing"
import {
  createStubAiProvider,
  type StubAiScriptStep,
} from "../ai-assistant/providers/stub-ai-provider"
import { createAiCrmTools } from "../ai-assistant/tools"
import { createAiGovernanceService } from "../ai-governance/service"
import type {
  AiActionApplierPort,
  AiActionApprovalRecord,
  AiActionMutation,
  AiActionRequestRecord,
  AiGovernanceStore,
  AiPolicyRecord,
} from "../ai-governance/types"
import type {
  ReportExecutionRequest,
  ReportObjectCatalogEntry,
  ReportRowScope,
} from "../reports/types"
import { createAiAgentService, AI_AGENT_SERVICE_METHODS } from "./service"
import { createAiAgentToolRegistry } from "./tools"
import type {
  AiAgent,
  AiAgentAuditInput,
  AiAgentRun,
  AiAgentRunJobRequest,
  AiAgentStore,
  AiAgentTriggerEnvelope,
} from "./types"

/**
 * Hermetic tests for the five properties that ARE this module.
 *
 * Everything below runs on the deterministic stub provider — no network,
 * no API key, no clock dependence — and on in-memory fakes that reproduce
 * the database facts the design leans on:
 *
 *  - `ai_agent_runs_event_idx UNIQUE (agent_id, trigger_event_id)`: the
 *    runs map is keyed on that pair, so a redelivered event reports
 *    `created: false` instead of producing a second run.
 *  - `ai_action_approvals_request_idx UNIQUE (request_id)`: the approvals
 *    map is keyed on `requestId`.
 *
 * The approval queue is NOT faked. These tests wire the REAL
 * `createAiGovernanceService` behind the agent's proposal tool, with a
 * SPY applier, so "no unapproved writes" is proven against the actual
 * gate rather than against a mock of it.
 */

const WS = "ws-ai-agents"
const OWNER = "user-owner"
const AUTHOR = "user-author"

type Harness = ReturnType<typeof makeHarness>

function toolCallStep(name: string, args: Record<string, unknown>, id = "call-1"): StubAiScriptStep {
  return { toolCalls: [{ id, name, arguments: args }] }
}

function makeHarness(options: {
  /** LIVE workspace roles, mutable mid-test: this is the demotion knob. */
  roles: Record<string, string>
  agent?: Partial<AiAgent>
  script?: readonly StubAiScriptStep[]
  policies?: Partial<AiPolicyRecord>[]
  queueFails?: boolean
}) {
  const roles = options.roles

  /* ------------------------------ agent store ----------------------------- */

  const agents = new Map<string, AiAgent>()
  const runs = new Map<string, AiAgentRun>()
  /** THIS MAP IS THE UNIQUE INDEX: `${agentId}:${triggerEventId}`. */
  const runKeys = new Map<string, string>()
  const marked: { agentId: string; at: Date }[] = []

  const agent: AiAgent = {
    id: "agent-1",
    workspaceId: WS,
    name: "Data hygiene",
    instructions: "Find people with a missing title and propose a fix.",
    status: "enabled",
    triggerType: "manual",
    triggerEvent: null,
    ownerId: OWNER,
    model: null,
    tools: ["crm_describe_objects", "crm_query", "crm_propose_change"],
    maxSteps: 4,
    maxToolCalls: 8,
    maxTotalTokens: 100_000,
    ...options.agent,
  }
  agents.set(agent.id, agent)

  const store: AiAgentStore = {
    list: async (workspaceId, query) => ({
      data: [...agents.values()].filter((row) => row.workspaceId === workspaceId),
      pagination: { nextCursor: null, limit: query.limit ?? 25 },
    }),
    findById: async (workspaceId, id) => {
      const row = agents.get(id)
      return row && row.workspaceId === workspaceId ? { ...row } : null
    },
    create: async (workspaceId, input, actorId) => {
      const row: AiAgent = {
        ...input,
        id: nextId("agent"),
        workspaceId,
        name: String(input.name),
        instructions: String(input.instructions),
        status: String(input.status ?? "disabled"),
        triggerType: String(input.triggerType ?? "manual"),
        createdBy: actorId ?? null,
      }
      agents.set(row.id, row)
      return { ...row }
    },
    update: async (workspaceId, id, input) => {
      const row = agents.get(id)
      if (!row || row.workspaceId !== workspaceId) return null
      Object.assign(row, input)
      return { ...row }
    },
    softDelete: async (_ws, id) => {
      agents.delete(id)
    },
    listEnabledByTrigger: async (workspaceId, triggerEvent) =>
      [...agents.values()].filter(
        (row) =>
          row.workspaceId === workspaceId &&
          row.status === "enabled" &&
          row.triggerType === "event" &&
          row.triggerEvent === triggerEvent,
      ),
    markAgentRan: async (_ws, id, at) => {
      marked.push({ agentId: id, at })
    },
    createRun: async (workspaceId, input) => {
      const key = `${String(input.agentId)}:${String(input.triggerEventId)}`
      const existingId = runKeys.get(key)
      if (existingId !== undefined) {
        const existing = runs.get(existingId)
        if (existing) return { run: { ...existing }, created: false }
      }
      const run: AiAgentRun = {
        ...input,
        id: nextId("agentrun"),
        workspaceId,
        agentId: String(input.agentId),
        status: String(input.status ?? "queued"),
        triggerEventId: String(input.triggerEventId),
      }
      runs.set(run.id, run)
      runKeys.set(key, run.id)
      return { run: { ...run }, created: true }
    },
    findRunById: async (workspaceId, id) => {
      const row = runs.get(id)
      return row && row.workspaceId === workspaceId ? { ...row } : null
    },
    listRuns: async (workspaceId, query) => ({
      data: [...runs.values()].filter(
        (row) =>
          row.workspaceId === workspaceId &&
          (query.agentId === undefined || row.agentId === query.agentId),
      ),
      pagination: { nextCursor: null, limit: query.limit ?? 25 },
    }),
    updateRun: async (workspaceId, id, patch) => {
      const row = runs.get(id)
      if (!row || row.workspaceId !== workspaceId) return null
      Object.assign(row, patch)
      return { ...row }
    },
  }

  /* ------------------------------ read tools ------------------------------ */

  const reportCalls: {
    workspaceId: string
    request: ReportExecutionRequest
    scope: ReportRowScope
  }[] = []

  const catalogue: ReportObjectCatalogEntry[] = [
    {
      objectType: "person",
      label: "Person",
      fields: [{ name: "title", label: "Title", type: "text" }],
    },
  ]

  const readTools = createAiCrmTools({
    reports: {
      describeObjects: () => catalogue,
      execute: async (workspaceId, request, scope) => {
        reportCalls.push({ workspaceId, request, scope })
        return {
          objectType: request.objectType,
          mode: "table" as const,
          scope: scope.kind,
          columns: [],
          rows: [{ id: "p1", title: null }],
          rowCount: 1,
          limit: 25,
          truncated: false,
        }
      },
    },
  })

  /* --------------------------- the approval queue -------------------------- */

  const requests = new Map<string, AiActionRequestRecord>()
  /** Keyed on requestId — this map IS the UNIQUE index. */
  const approvals = new Map<string, AiActionApprovalRecord>()
  const policies: AiPolicyRecord[] = (options.policies ?? []).map((policy, index) => ({
    id: policy.id ?? `policy-${String(index)}`,
    workspaceId: WS,
    objectType: policy.objectType ?? "*",
    action: policy.action ?? "*",
    mode: policy.mode ?? "require_approval",
    enabled: policy.enabled ?? true,
    ...policy,
  }))
  /** THE SPY THAT MATTERS: nothing may ever reach this. */
  const applies: AiActionMutation[] = []
  const applier: AiActionApplierPort = {
    applyAiAction: async (_ctx, mutation) => {
      applies.push(mutation)
      return { recordId: mutation.recordId ?? "new-record" }
    },
    revertAiAction: async (_ctx, mutation) => {
      applies.push(mutation)
      return { recordId: mutation.recordId ?? "new-record" }
    },
  }

  const governanceStore: AiGovernanceStore = {
    listPolicies: async () => ({ data: policies, pagination: { nextCursor: null, limit: 25 } }),
    listActivePolicies: async () => policies.filter((policy) => policy.enabled !== false),
    findPolicyById: async (_ws, id) => policies.find((policy) => policy.id === id) ?? null,
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
      const found = policies.find((policy) => policy.id === id)
      if (!found) return null
      Object.assign(found, input)
      return found
    },
    softDeletePolicy: async (_ws, id) => {
      const index = policies.findIndex((policy) => policy.id === id)
      if (index >= 0) policies.splice(index, 1)
    },
    listRequests: async (workspaceId, query) => ({
      data: [...requests.values()].filter((row) => row.workspaceId === workspaceId),
      pagination: { nextCursor: null, limit: query.limit ?? 25 },
    }),
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
      Object.assign(row, patch)
      return { ...row }
    },
    recordDecision: async (workspaceId, input) => {
      const requestId = String(input.requestId)
      const existing = approvals.get(requestId)
      if (existing) return { approval: existing, created: false }
      const approval: AiActionApprovalRecord = {
        id: nextId("approval"),
        workspaceId,
        requestId,
        decision: String(input.decision),
        approverId: String(input.approverId),
      }
      approvals.set(requestId, approval)
      return { approval, created: true }
    },
    findApprovalByRequest: async (_ws, requestId) => approvals.get(requestId) ?? null,
    claimRequestApply: async (workspaceId, id, claim) => {
      const row = requests.get(id)
      if (!row || row.workspaceId !== workspaceId) return { request: null, claimed: false }
      if (row.status !== "approved" || row.applyClaimedAt != null) {
        return { request: { ...row }, claimed: false }
      }
      row.applyClaimedAt = claim.claimedAt
      return { request: { ...row }, claimed: true }
    },
    claimRequestRevert: async (workspaceId, id, claim) => {
      const row = requests.get(id)
      if (!row || row.workspaceId !== workspaceId) return { request: null, claimed: false }
      if (row.status !== "applied" || row.revertClaimedAt != null) {
        return { request: { ...row }, claimed: false }
      }
      row.revertClaimedAt = claim.claimedAt
      return { request: { ...row }, claimed: true }
    },
  }

  const governanceAudits: { action: string; object: string }[] = []
  const governance = createAiGovernanceService({
    store: governanceStore,
    audit: async (input) => {
      governanceAudits.push({ action: input.action, object: input.object })
    },
    events: { emit: async () => {} },
    applier,
    resolveActorRole: async (_ws, actorId) => roles[actorId] ?? null,
  })

  /* ------------------------------ the service ----------------------------- */

  const provider = createStubAiProvider({ script: options.script ?? [] })
  const tools = createAiAgentToolRegistry({ readTools, proposals: governance })
  const audits: AiAgentAuditInput[] = []
  const emitted: { event: string; after?: unknown; correlationId?: string }[] = []
  const queued: AiAgentRunJobRequest[] = []

  const service = createAiAgentService({
    store,
    provider,
    tools,
    audit: async (input) => {
      audits.push(input)
    },
    events: {
      emit: async (event) => {
        emitted.push({
          event: event.event,
          after: event.after,
          ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
        })
      },
    },
    queue: {
      enqueueAiAgentRun: async (request) => {
        if (options.queueFails === true) throw new Error("redis is down")
        queued.push(request)
      },
    },
    resolveActorRole: async (_ws, actorId) => roles[actorId] ?? null,
    pricing: { "stub-echo-1": { inputMicrosPerMillion: 1_000, outputMicrosPerMillion: 2_000 } },
    now: () => new Date("2026-09-20T10:00:00Z"),
  })

  return {
    service,
    store,
    agent,
    agents,
    runs,
    marked,
    provider,
    tools,
    audits,
    emitted,
    queued,
    reportCalls,
    requests,
    applies,
    governance,
    governanceAudits,
    roles,
  }
}

/** Queue a manual run and execute it, the way the worker would. */
async function runManually(harness: Harness, input = "Do your job."): Promise<string> {
  const ctx = makeServiceContext({ workspaceId: WS, actorId: AUTHOR, role: "admin" })
  const run = await harness.service.runNow(ctx, harness.agent.id, { input })
  return run.id
}

beforeEach(() => {
  resetIdCounter()
})

/* ======================= 1. NO UNAPPROVED WRITES ========================= */

describe("ai-agents/no unapproved writes", () => {
  test("an agent that decides to change a record produces a PENDING request and mutates nothing", async () => {
    const harness = makeHarness({
      roles: { [OWNER]: "member", [AUTHOR]: "admin" },
      script: [
        toolCallStep("crm_propose_change", {
          objectType: "person",
          recordId: "p1",
          action: "update",
          before: { title: null },
          after: { title: "Head of Ops" },
          rationale: "The title is empty and the email signature says Head of Ops.",
        }),
        { text: "I proposed one title fix for review." },
      ],
    })

    const runId = await runManually(harness)
    const outcome = await harness.service.executeRun(WS, runId)

    // A proposal exists, and it is waiting for a human.
    const queuedRequests = [...harness.requests.values()]
    expect(queuedRequests).toHaveLength(1)
    expect(queuedRequests[0]?.status).toBe("pending")
    expect(queuedRequests[0]?.actorType).toBe("agent")
    expect(queuedRequests[0]?.agentId).toBe(harness.agent.id)
    expect(queuedRequests[0]?.runId).toBe(runId)
    expect(queuedRequests[0]?.rationale).toContain("Head of Ops")

    // NOTHING was applied. The applier is the only thing in this test that
    // can touch a record, and it was never called.
    expect(harness.applies).toHaveLength(0)

    // The run says so too, and the agent reported it honestly.
    expect(outcome.status).toBe("succeeded")
    expect(outcome.proposalCount).toBe(1)
    expect(harness.runs.get(runId)?.proposalCount).toBe(1)
    expect(outcome.toolCalls[0]?.access).toBe("propose")
    expect(outcome.toolCalls[0]?.requestId).toBe(String(queuedRequests[0]?.id))
  })

  test("the agent cannot approve its own proposal", async () => {
    const harness = makeHarness({
      roles: { [OWNER]: "admin" },
      script: [
        toolCallStep("crm_propose_change", {
          objectType: "person",
          recordId: "p1",
          action: "update",
          before: { title: null },
          after: { title: "Head of Ops" },
          rationale: "Fill the missing title.",
        }),
        { text: "done" },
      ],
    })
    const runId = await runManually(harness)
    await harness.service.executeRun(WS, runId)
    const request = [...harness.requests.values()][0]
    expect(request?.status).toBe("pending")

    // Approving as the agent itself is refused at the service boundary.
    await expect(
      harness.governance.approve(
        { workspaceId: WS, actorId: OWNER, role: "admin", actorType: "agent" },
        String(request?.id),
        {},
      ),
    ).rejects.toThrow(/AI actor cannot approve/)
    expect(harness.applies).toHaveLength(0)
  })

  test("the service surface exposes no way to apply a change", () => {
    const harness = makeHarness({ roles: { [OWNER]: "admin" } })
    expect(Object.keys(harness.service).sort()).toEqual([...AI_AGENT_SERVICE_METHODS])
    for (const name of AI_AGENT_SERVICE_METHODS) {
      expect(name).not.toMatch(/apply|approve|mutate|write|delete_record/)
    }
  })

  test("every tool an agent can hold is a read or a proposal", () => {
    const harness = makeHarness({ roles: { [OWNER]: "admin" } })
    const accesses = harness.tools.list().map((tool) => tool.access)
    expect(new Set(accesses)).toEqual(new Set(["read", "propose"]))
    expect(harness.tools.list().filter((tool) => tool.access === "propose")).toHaveLength(1)
  })
})

/* ========================== 2. BOUNDED LOOPS ============================= */

describe("ai-agents/bounded loops", () => {
  /** A provider that never stops asking for tools. */
  const forever: StubAiScriptStep[] = Array.from({ length: 50 }, (_, index) =>
    toolCallStep("crm_query", { objectType: "person" }, `call-${String(index)}`),
  )

  test("a model that always calls a tool terminates at the step ceiling and records `exhausted`", async () => {
    const harness = makeHarness({
      roles: { [OWNER]: "admin" },
      agent: { maxSteps: 3, maxToolCalls: 20, maxTotalTokens: 100_000 },
      script: forever,
    })
    const runId = await runManually(harness)
    const outcome = await harness.service.executeRun(WS, runId)

    expect(outcome.status).toBe("exhausted")
    expect(outcome.steps).toBe(3)
    // The loop stopped: the provider was called exactly three times.
    expect(harness.provider.calls).toHaveLength(3)
    const run = harness.runs.get(runId)
    expect(run?.status).toBe("exhausted")
    expect(run?.errorCode).toBe("AI_AGENT_BUDGET_EXHAUSTED")
    expect(String(run?.error)).toContain("step budget")
  })

  test("the tool-call ceiling stops a run even when steps remain", async () => {
    const harness = makeHarness({
      roles: { [OWNER]: "admin" },
      agent: { maxSteps: 10, maxToolCalls: 2, maxTotalTokens: 100_000 },
      script: forever,
    })
    const runId = await runManually(harness)
    const outcome = await harness.service.executeRun(WS, runId)

    expect(outcome.status).toBe("exhausted")
    expect(outcome.toolCalls).toHaveLength(2)
    expect(harness.runs.get(runId)?.toolCallCount).toBe(2)
    expect(String(harness.runs.get(runId)?.error)).toContain("tool-call budget")
  })

  test("the token ceiling stops a run", async () => {
    const harness = makeHarness({
      roles: { [OWNER]: "admin" },
      agent: { maxSteps: 10, maxToolCalls: 20, maxTotalTokens: 1_500 },
      script: forever.map((step) => ({
        ...step,
        usage: { promptTokens: 700, completionTokens: 100, totalTokens: 800 },
      })),
    })
    const runId = await runManually(harness)
    const outcome = await harness.service.executeRun(WS, runId)

    expect(outcome.status).toBe("exhausted")
    expect(outcome.steps).toBe(2)
    expect(outcome.totalTokens).toBe(1_600)
    expect(String(harness.runs.get(runId)?.error)).toContain("token budget")
  })

  test("a hand-edited row cannot buy an unbounded loop: budgets are clamped at execution", async () => {
    const harness = makeHarness({
      roles: { [OWNER]: "admin" },
      // Somebody wrote 9999 straight into the table, past the CHECK.
      agent: { maxSteps: 9_999, maxToolCalls: 9_999, maxTotalTokens: 9_999_999 },
      script: forever,
    })
    const runId = await runManually(harness)
    const outcome = await harness.service.executeRun(WS, runId)

    expect(outcome.status).toBe("exhausted")
    // AI_AGENT_MAX_STEPS_CEILING, not 9999.
    expect(outcome.steps).toBe(12)
    expect(harness.provider.calls).toHaveLength(12)
  })

  test("a tool the agent is not scoped to is blocked, not executed", async () => {
    const harness = makeHarness({
      roles: { [OWNER]: "admin" },
      agent: { tools: ["crm_describe_objects"] },
      script: [
        toolCallStep("crm_query", { objectType: "person" }),
        { text: "I could not look that up." },
      ],
    })
    const runId = await runManually(harness)
    const outcome = await harness.service.executeRun(WS, runId)

    expect(outcome.toolCalls[0]?.outcome).toBe("blocked")
    // The query engine was never reached.
    expect(harness.reportCalls).toHaveLength(0)
  })
})

/* ====================== 3. PERMISSION INHERITANCE ======================== */

describe("ai-agents/permission inheritance", () => {
  const queryOnce: StubAiScriptStep[] = [
    toolCallStep("crm_query", { objectType: "person" }),
    { text: "One person has no title." },
  ]

  test("a viewer-owned agent sees exactly what a viewer sees", async () => {
    const harness = makeHarness({ roles: { [OWNER]: "viewer" }, script: queryOnce })
    const runId = await runManually(harness)
    const outcome = await harness.service.executeRun(WS, runId)

    expect(outcome.status).toBe("succeeded")
    expect(harness.reportCalls).toHaveLength(1)
    // `own` scope: the query engine was told to return the OWNER's records.
    expect(harness.reportCalls[0]?.scope).toEqual({ kind: "own", actorId: OWNER })
    expect(harness.runs.get(runId)?.actorRole).toBe("viewer")
  })

  test("an admin-owned agent sees the whole workspace", async () => {
    const harness = makeHarness({ roles: { [OWNER]: "admin" }, script: queryOnce })
    const runId = await runManually(harness)
    await harness.service.executeRun(WS, runId)
    expect(harness.reportCalls[0]?.scope).toEqual({ kind: "workspace" })
  })

  test("the role is re-resolved LIVE: demoting the owner narrows the next run", async () => {
    const harness = makeHarness({ roles: { [OWNER]: "admin" }, script: queryOnce })
    // Queued while the owner was an admin…
    const runId = await runManually(harness)
    // …demoted before the worker picks it up.
    harness.roles[OWNER] = "viewer"
    await harness.service.executeRun(WS, runId)

    expect(harness.reportCalls[0]?.scope).toEqual({ kind: "own", actorId: OWNER })
    expect(harness.runs.get(runId)?.actorRole).toBe("viewer")
  })

  test("a viewer-owned agent is refused when it proposes a write, and nothing is queued", async () => {
    const harness = makeHarness({
      roles: { [OWNER]: "viewer" },
      script: [
        toolCallStep("crm_propose_change", {
          objectType: "person",
          recordId: "p1",
          action: "update",
          before: { title: null },
          after: { title: "Head of Ops" },
          rationale: "Fill the missing title.",
        }),
        { text: "I am not allowed to propose that." },
      ],
    })
    const runId = await runManually(harness)
    const outcome = await harness.service.executeRun(WS, runId)

    // The tool was denied — `run_ai` is a member-rank action.
    expect(outcome.toolCalls[0]?.outcome).toBe("denied")
    expect(harness.requests.size).toBe(0)
    expect(harness.applies).toHaveLength(0)
    // The run itself still completes: a refusal is information, not a crash.
    expect(outcome.status).toBe("succeeded")
    expect(outcome.proposalCount).toBe(0)
  })

  test("an agent whose owner left the workspace refuses to run at all", async () => {
    const harness = makeHarness({ roles: {}, script: queryOnce })
    const runId = await runManually(harness)
    const outcome = await harness.service.executeRun(WS, runId)

    expect(outcome.status).toBe("denied")
    expect(String(harness.runs.get(runId)?.error)).toContain("no longer a member")
    // Not one token was spent.
    expect(harness.provider.calls).toHaveLength(0)
  })

  test("authoring is gated: a viewer cannot create, enable or run an agent", async () => {
    const harness = makeHarness({ roles: { [OWNER]: "admin" } })
    const viewer = makeServiceContext({ workspaceId: WS, actorId: "user-viewer", role: "viewer" })
    await expectDenied(() =>
      harness.service.create(viewer, { name: "x", instructions: "y", tools: [] }),
    )
    await expectDenied(() => harness.service.setStatus(viewer, harness.agent.id, {
      status: "enabled",
    }))
    await expectDenied(() => harness.service.runNow(viewer, harness.agent.id, {}))
  })

  test("an author cannot hand ownership to somebody more privileged", async () => {
    const harness = makeHarness({ roles: { [OWNER]: "admin" } })
    const member = makeServiceContext({ workspaceId: WS, actorId: "user-member", role: "member" })
    await expectDenied(() =>
      harness.service.create(member, {
        name: "Sneaky",
        instructions: "do things",
        tools: [],
        ownerId: "user-owner",
      }),
    )
  })

  test("a definition may only name tools the registry offers", async () => {
    const harness = makeHarness({ roles: { [OWNER]: "admin" } })
    const admin = makeServiceContext({ workspaceId: WS, actorId: AUTHOR, role: "admin" })
    await expect(
      harness.service.create(admin, {
        name: "Rogue",
        instructions: "do things",
        tools: ["crm_delete_everything"],
      }),
    ).rejects.toThrow(/unknown agent tool/)
  })
})

/* ============================ 4. IDEMPOTENCY ============================= */

describe("ai-agents/idempotency", () => {
  const eventAgent: Partial<AiAgent> = {
    triggerType: "event",
    triggerEvent: "person.created",
    tools: ["crm_query"],
  }

  function envelope(overrides: Partial<AiAgentTriggerEnvelope> = {}): AiAgentTriggerEnvelope {
    return {
      eventId: "evt-1",
      event: "person.created",
      workspaceId: WS,
      entityType: "person",
      entityId: "p1",
      ...overrides,
    }
  }

  test("redelivering the triggering event does not run the agent twice", async () => {
    const harness = makeHarness({ roles: { [OWNER]: "admin" }, agent: eventAgent })

    const first = await harness.service.dispatch(envelope())
    const second = await harness.service.dispatch(envelope())

    expect(first.decisions[0]?.outcome).toBe("queued")
    expect(second.decisions[0]?.outcome).toBe("duplicate")
    expect(second.decisions[0]?.runId).toBe(String(first.decisions[0]?.runId))
    // One run, one enqueue: the agent runs once for one event.
    expect(harness.runs.size).toBe(1)
    expect(harness.queued).toHaveLength(1)
  })

  test("a redelivered job does not re-execute a finished run", async () => {
    const harness = makeHarness({
      roles: { [OWNER]: "admin" },
      agent: eventAgent,
      script: [{ text: "Nothing to do." }],
    })
    const dispatched = await harness.service.dispatch(envelope())
    const runId = String(dispatched.decisions[0]?.runId)

    const first = await harness.service.executeRun(WS, runId)
    const second = await harness.service.executeRun(WS, runId)

    expect(first.status).toBe("succeeded")
    expect(second.status).toBe("succeeded")
    // The second delivery spent no tokens.
    expect(harness.provider.calls).toHaveLength(1)
    expect(second.steps).toBe(first.steps)
  })

  test("a failed enqueue is recorded rather than silently swallowed", async () => {
    const harness = makeHarness({
      roles: { [OWNER]: "admin" },
      agent: eventAgent,
      queueFails: true,
    })
    const dispatched = await harness.service.dispatch(envelope())
    expect(dispatched.decisions[0]?.outcome).toBe("queue_failed")
    const run = harness.runs.get(String(dispatched.decisions[0]?.runId))
    expect(run?.status).toBe("failed")
    expect(String(run?.error)).toContain("could not queue")
  })

  test("an agent-caused cascade terminates at the depth ceiling", async () => {
    const harness = makeHarness({ roles: { [OWNER]: "admin" }, agent: eventAgent })
    // A run at the ceiling, as a parent.
    const seed = await harness.store.createRun(WS, {
      agentId: harness.agent.id,
      triggerType: "event",
      triggerEventId: "evt-seed",
      status: "succeeded",
      depth: 3,
    })
    const dispatched = await harness.service.dispatch(
      envelope({ eventId: "evt-2", correlationId: `agentrun:${seed.run.id}` }),
    )

    expect(dispatched.decisions[0]?.outcome).toBe("queue_failed")
    const run = harness.runs.get(String(dispatched.decisions[0]?.runId))
    expect(run?.status).toBe("skipped")
    expect(String(run?.error)).toContain("cascade depth")
    // Nothing was enqueued, so the chain stops here.
    expect(harness.queued).toHaveLength(0)
  })

  test("a manual run is keyed per press, so two presses are two runs", async () => {
    const harness = makeHarness({ roles: { [OWNER]: "admin" } })
    const first = await runManually(harness)
    const second = await runManually(harness)
    expect(first).not.toBe(second)
    expect(harness.queued).toHaveLength(2)
  })
})

/* =========================== 5. COST IS RECORDED ========================= */

describe("ai-agents/cost and attribution", () => {
  test("every run records tokens, latency and cost against a model and a run id", async () => {
    const harness = makeHarness({
      roles: { [OWNER]: "admin" },
      script: [
        {
          ...toolCallStep("crm_query", { objectType: "person" }),
          usage: { promptTokens: 400, completionTokens: 100, totalTokens: 500 },
          latencyMs: 120,
        },
        {
          text: "One person has no title.",
          usage: { promptTokens: 600, completionTokens: 200, totalTokens: 800 },
          latencyMs: 80,
        },
      ],
    })
    const runId = await runManually(harness)
    const outcome = await harness.service.executeRun(WS, runId)

    const run = harness.runs.get(runId)
    expect(run?.promptTokens).toBe(1_000)
    expect(run?.completionTokens).toBe(300)
    expect(run?.totalTokens).toBe(1_300)
    expect(run?.latencyMs).toBe(200)
    expect(run?.model).toBe("stub-echo-1")
    expect(run?.providerId).toBe("stub")
    expect(run?.steps).toBe(2)
    // 1000 prompt tokens at 1000 micro-USD/M + 300 completion at 2000/M.
    expect(run?.costMicros).toBe(2)
    expect(outcome.costMicros).toBe(2)

    // The run is auditable as an AI act, attributable to model + run id.
    const runAudit = harness.audits.find((audit) => audit.object === "ai_agent_run")
    expect(runAudit?.source).toBe("ai")
    expect(runAudit?.recordId).toBe(runId)
    expect(runAudit?.correlationId).toBe(`agentrun:${runId}`)
    expect((runAudit?.after as { model?: string }).model).toBe("stub-echo-1")
    expect((runAudit?.after as { totalTokens?: number }).totalTokens).toBe(1_300)

    // …and so is every individual tool call.
    const toolAudit = harness.audits.find((audit) => audit.object === "ai_agent_tool")
    expect(toolAudit?.source).toBe("ai")
    expect(toolAudit?.action).toBe("tool.crm_query")
    expect((toolAudit?.after as { runId?: string }).runId).toBe(runId)
    expect((toolAudit?.after as { model?: string }).model).toBe("stub-echo-1")

    // Events carry the same attribution.
    const completed = harness.emitted.find((event) => event.event === AiEvents.AgentCompleted)
    expect(completed?.correlationId).toBe(`agentrun:${runId}`)
    expect(harness.emitted.some((event) => event.event === AiEvents.ToolCalled)).toBe(true)
    expect(harness.marked).toHaveLength(1)
  })

  test("a provider failure is recorded as a failed run with its tokens", async () => {
    const harness = makeHarness({
      roles: { [OWNER]: "admin" },
      script: [{ error: new Error("upstream exploded") }],
    })
    const runId = await runManually(harness)
    const outcome = await harness.service.executeRun(WS, runId)

    expect(outcome.status).toBe("failed")
    const run = harness.runs.get(runId)
    expect(run?.status).toBe("failed")
    expect(String(run?.error)).toContain("upstream exploded")
    expect(run?.finishedAt).toBeInstanceOf(Date)
  })
})
