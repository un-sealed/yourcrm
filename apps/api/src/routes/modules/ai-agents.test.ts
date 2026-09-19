import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createAiAgentService,
  createAiAgentToolRegistry,
  type AiAgent,
  type AiAgentRun,
  type AiAgentRunJobRequest,
  type AiAgentService,
  type AiAgentStore,
} from "@yourcrm/crm/src/ai-agents"
import { createAiCrmTools, createStubAiProvider } from "@yourcrm/crm/src/ai-assistant"
import type { AiActionProposalPort } from "@yourcrm/crm/src/ai-governance"
import { createApiClient, makeSession, nextId, resetIdCounter } from "@yourcrm/testing"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes, openApiPaths } from "./ai-agents"

/**
 * Hermetic API test: the route factory takes a service, so this injects
 * the REAL domain service over in-memory stores and the deterministic
 * stub provider. No Postgres, no Redis, no network, no API key.
 *
 * What is under test here is the HTTP contract: that a refusal is a 403
 * and not a 500, that a manual run is accepted as a queued 202 rather
 * than executed on the connection, that the run-history route is not
 * shadowed by `/:id` — and that no route exists through which an agent
 * applies anything.
 */

const WS = "ws-ai-agents-api"

function makeFake(options: { roles: Record<string, string> }) {
  const agents = new Map<string, AiAgent>()
  const runs = new Map<string, AiAgentRun>()
  const runKeys = new Map<string, string>()
  const queued: AiAgentRunJobRequest[] = []
  /** The proposal port: an agent's only route to a write, spied on here. */
  const proposed: unknown[] = []
  const proposals: AiActionProposalPort = {
    requestAction: async (ctx, input) => {
      proposed.push(input)
      return {
        request: {
          id: nextId("airq"),
          workspaceId: ctx.workspaceId,
          actorId: ctx.actorId,
          objectType: "person",
          action: "update",
          status: "pending",
        },
        mode: "require_approval",
        applied: false,
      }
    },
  }

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
    listEnabledByTrigger: async () => [],
    markAgentRan: async () => {},
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

  const readTools = createAiCrmTools({
    reports: {
      describeObjects: () => [],
      execute: async (_ws, request, scope) => ({
        objectType: request.objectType,
        mode: "table" as const,
        scope: scope.kind,
        columns: [],
        rows: [],
        rowCount: 0,
        limit: 25,
        truncated: false,
      }),
    },
  })

  const service = createAiAgentService({
    store,
    provider: createStubAiProvider({ script: [{ text: "nothing to do" }] }),
    tools: createAiAgentToolRegistry({ readTools, proposals }),
    audit: async () => {},
    events: { emit: async () => {} },
    queue: {
      enqueueAiAgentRun: async (request) => {
        queued.push(request)
      },
    },
    resolveActorRole: async (_ws, actorId) => options.roles[actorId] ?? null,
  })

  return { service, store, agents, runs, queued, proposed }
}

function makeTestApp(session: { current: Session | null }, service: AiAgentService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    const requestId = c.req.header("x-request-id")
    if (requestId !== undefined) c.set("requestId", requestId)
    await next()
  })
  app.route("/api/v1/ai/agents", createRoutes({ service }))
  return app
}

const DEFINITION = {
  name: "Data hygiene",
  instructions: "Find people with a missing title and propose a fix.",
  tools: ["crm_query", "crm_propose_change"],
}

describe("api/ai-agents", () => {
  let session: { current: Session | null }
  let fake: ReturnType<typeof makeFake>
  let admin: Session
  let member: Session
  let viewer: Session

  beforeEach(() => {
    resetIdCounter()
    admin = makeSession({ role: "admin", workspaceId: WS })
    member = makeSession({ role: "member", workspaceId: WS })
    viewer = makeSession({ role: "viewer", workspaceId: WS })
    session = { current: admin }
    fake = makeFake({
      roles: {
        [admin.user.id]: "admin",
        [member.user.id]: "member",
        [viewer.user.id]: "viewer",
      },
    })
  })

  const client = () => createApiClient({ app: makeTestApp(session, fake.service) })

  async function createAgent(): Promise<{ id: string; status: string }> {
    session.current = admin
    const res = await client().post("/api/v1/ai/agents", DEFINITION)
    expect(res.status).toBe(201)
    return res.expectSuccess().data as { id: string; status: string }
  }

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const res = await client().get("/api/v1/ai/agents")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("a new agent is created disabled", async () => {
    const agent = await createAgent()
    expect(agent.status).toBe("disabled")
  })

  test("a viewer cannot create an agent — 403, not 500", async () => {
    session.current = viewer
    const res = await client().post("/api/v1/ai/agents", DEFINITION)
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
  })

  test("a definition naming an unknown tool is a 400", async () => {
    session.current = admin
    const res = await client().post("/api/v1/ai/agents", {
      ...DEFINITION,
      tools: ["crm_delete_everything"],
    })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("an event-triggered agent must name its event", async () => {
    session.current = admin
    const res = await client().post("/api/v1/ai/agents", {
      ...DEFINITION,
      triggerType: "event",
    })
    expect(res.status).toBe(400)
    res.expectError("VALIDATION_ERROR")
  })

  test("enabling needs run_ai: a viewer is refused", async () => {
    const agent = await createAgent()
    session.current = viewer
    const res = await client().post(`/api/v1/ai/agents/${agent.id}/status`, { status: "enabled" })
    expect(res.status).toBe(403)
  })

  test("a manual run is accepted as queued (202) and never executed on the connection", async () => {
    const agent = await createAgent()
    session.current = member
    const res = await client().post(`/api/v1/ai/agents/${agent.id}/run`, { input: "Go" })
    expect(res.status).toBe(202)
    const run = res.expectSuccess().data as { id: string; status: string }
    expect(run.status).toBe("queued")
    expect(fake.queued).toHaveLength(1)
    // Nothing ran, so nothing was proposed and no tokens were spent.
    expect(fake.proposed).toHaveLength(0)
  })

  test("run history is served under /runs, not shadowed by /:id", async () => {
    const agent = await createAgent()
    session.current = member
    await client().post(`/api/v1/ai/agents/${agent.id}/run`, { input: "Go" })

    const list = await client().get("/api/v1/ai/agents/runs")
    expect(list.status).toBe(200)
    const body = list.expectSuccess()
    const rows = body.data as { id: string }[]
    expect(rows).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })

    const runId = String(rows[0]?.id)
    const one = await client().get(`/api/v1/ai/agents/runs/${runId}`)
    expect(one.status).toBe(200)

    const perAgent = await client().get(`/api/v1/ai/agents/${agent.id}/runs`)
    expect(perAgent.status).toBe(200)
    expect(perAgent.expectSuccess().data).toHaveLength(1)
  })

  test("the catalogue is served before /:id and publishes the budget ceilings", async () => {
    session.current = member
    const res = await client().get("/api/v1/ai/agents/catalogue")
    expect(res.status).toBe(200)
    const data = res.expectSuccess().data as {
      statuses: string[]
      runStatuses: string[]
      triggerEvents: string[]
      limits: { maxSteps: number; maxToolCalls: number; maxTotalTokens: number }
    }
    expect(data.statuses).toEqual(["disabled", "enabled"])
    expect(data.runStatuses).toContain("exhausted")
    expect(data.triggerEvents).toContain("person.created")
    expect(data.limits).toEqual({ maxSteps: 12, maxToolCalls: 24, maxTotalTokens: 200_000 })
  })

  test("an unknown agent is a 404", async () => {
    session.current = member
    const res = await client().get("/api/v1/ai/agents/nope")
    expect(res.status).toBe(404)
    res.expectError("NOT_FOUND")
  })

  test("no route can apply, approve or execute an AI write", () => {
    const paths = Object.keys(openApiPaths)
    for (const path of paths) {
      expect(path).not.toMatch(/apply|approve|revert/)
    }
    // Approving lives in the governance module, where a human does it.
    expect(paths.some((path) => path.endsWith("/run"))).toBe(true)
  })
})
