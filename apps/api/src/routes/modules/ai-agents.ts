import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import { loadEnv } from "@yourcrm/config"
import {
  aiAgentQuerySchema,
  aiAgentRunQuerySchema,
  aiAgentRunSchema,
  aiAgentSchema,
  createAiAgentSchema,
  createAiAgentService,
  createAiAgentToolRegistry,
  runAiAgentSchema,
  setAiAgentStatusSchema,
  subscribeAiAgentDispatcher,
  updateAiAgentSchema,
  AI_AGENT_MAX_STEPS_CEILING,
  AI_AGENT_MAX_TOOL_CALLS_CEILING,
  AI_AGENT_MAX_TOTAL_TOKENS_CEILING,
  AI_AGENT_RUN_STATUSES,
  AI_AGENT_STATUSES,
  AI_AGENT_TRIGGER_EVENTS,
  AI_AGENT_TRIGGER_TYPES,
  type AiAgentRunJobRequest,
  type AiAgentService,
} from "@yourcrm/crm/src/ai-agents"
import { createAiCrmTools, createOpenAiCompatibleAiProvider } from "@yourcrm/crm/src/ai-assistant"
import { getDb, writeAudit } from "@yourcrm/database"
import {
  createAiAgentsRepository,
  type CreateAiAgentRecordInput,
  type CreateAiAgentRunInput,
  type UpdateAiAgentRecordInput,
  type UpdateAiAgentRunInput,
} from "@yourcrm/database/src/repositories/ai-agents-repository"
import {
  createReportsRepository,
  describeReportObjects,
  type ReportExecutionRequest,
  type ReportRowScope,
} from "@yourcrm/database/src/repositories/reports-repository"
import { listMembershipsForUser } from "@yourcrm/database/src/schema/auth"
import { getEventBus } from "@yourcrm/events"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"
import { createDefaultAiGovernanceService } from "./ai-governance"

/**
 * AI agents (spec 36-ai-agents, P0).
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. The properties
 * that matter — no unapproved writes, bounded loops, live permission
 * inheritance, idempotency, recorded cost — all live in
 * `@yourcrm/crm/src/ai-agents`; this file only BINDS them:
 *
 *   store            -> the AI agents repository (migration 0400)
 *   provider         -> the OpenAI-compatible provider, from validated env
 *   tools            -> the ASSISTANT's read tools (the same registry the
 *                       Ask-Your-CRM box uses, over the reports engine)
 *                       plus `crm_propose_change`
 *   proposals        -> the ONE governance service
 *                       (`./ai-governance.ts`), so an agent's only route
 *                       to a write is the same approval queue a human
 *                       reviews. There is no applier in this file, and no
 *                       domain service: nothing here can change a record.
 *   audit            -> writeAudit, `source: "ai"`
 *   queue            -> the worker's `ai.agent.run` job (see the note)
 *   resolveActorRole -> the memberships table (the OWNER's LIVE role)
 *
 * INTEGRATION NOTES
 * -----------------
 *  1. MOUNTING. This module is not in the generated
 *     `routes/modules/index.ts` until the integrator runs
 *     `bun run gen:routes`.
 *  2. THE QUEUE. `apps/api` does not declare `bullmq`, and an agent may
 *     not edit `package.json`, so `defaultQueue()` logs the enqueue
 *     instead of performing it — the same documented gap automation and
 *     sequences report. Runs are recorded and idempotent either way; they
 *     simply are not executed until the four-line body below is restored
 *     and `registerAiAgentRunner(...)` is bound in the worker bootstrap.
 *  3. THE DISPATCHER. `subscribeAiAgentDispatcher` must be called once at
 *     boot from `apps/api/src/index.ts`, next to the automation one, or
 *     event-triggered agents never wake up. `subscribeAiAgentRuns()`
 *     below is the bound one-liner.
 */

export const basePath = "/ai/agents"

const aiAgentEnvelope = z.object({ data: aiAgentSchema.passthrough() })
const aiAgentListEnvelope = paginatedEnvelopeSchema(aiAgentSchema.passthrough())
const aiAgentRunListEnvelope = paginatedEnvelopeSchema(aiAgentRunSchema.passthrough())

export type AiAgentsRouteDeps = {
  service?: AiAgentService
}

class AiAgentsNotConfiguredError extends Error {
  readonly code = "AI_PROVIDER_NOT_CONFIGURED"
  constructor() {
    super("the AI provider is not configured (set AI_API_KEY and AI_DEFAULT_MODEL)")
    this.name = "AiAgentsNotConfiguredError"
  }
}

/**
 * Queue binding. The domain service only knows `AiAgentRunQueuePort`; the
 * job name, payload schema and deterministic job id live in
 * `apps/worker/src/jobs/ai-agent.ts`.
 *
 * Replace the body with, once `bullmq` is a declared dependency of
 * `@yourcrm/api`:
 *
 * ```ts
 * await getQueue(QueueNames.Ai).add(AI_AGENT_RUN_JOB_NAME, request, {
 *   jobId: aiAgentRunJobId(request),
 * })
 * ```
 */
function defaultQueue() {
  return {
    enqueueAiAgentRun: async (request: AiAgentRunJobRequest): Promise<void> => {
      console.log(
        JSON.stringify({
          level: "info",
          msg: "ai_agent_run_enqueued",
          job: "ai.agent.run",
          jobId: `ai.agent.run:${request.workspaceId}:${request.agentId}:${request.triggerEventId}`,
          runId: request.runId,
          ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
        }),
      )
    },
  }
}

function defaultService(): AiAgentService {
  const db = getDb()
  const env = loadEnv()
  const repository = createAiAgentsRepository()
  const reports = createReportsRepository()

  if (!env.AI_API_KEY || !env.AI_DEFAULT_MODEL) throw new AiAgentsNotConfiguredError()

  /**
   * The read side: the assistant's own tools over the reports engine, so
   * an agent's reads are the reads its owner could already run by hand,
   * with that owner's row scope. No second query path exists.
   */
  const readTools = createAiCrmTools({
    reports: {
      describeObjects: () => describeReportObjects(),
      execute: (workspaceId, request, scope) =>
        reports.execute(
          db,
          workspaceId,
          request as unknown as ReportExecutionRequest,
          scope as ReportRowScope,
        ),
    },
  })

  return createAiAgentService({
    store: {
      list: (workspaceId, query) =>
        repository.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          status: query.status,
          triggerType: query.triggerType,
          triggerEvent: query.triggerEvent,
        }),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreateAiAgentRecordInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(
          db,
          workspaceId,
          id,
          input as unknown as UpdateAiAgentRecordInput,
          actorId,
        ),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDelete(db, workspaceId, id, actorId)
      },
      listEnabledByTrigger: (workspaceId, triggerEvent) =>
        repository.listEnabledByTrigger(db, workspaceId, triggerEvent),
      markAgentRan: async (workspaceId, id, at) => {
        await repository.markAgentRan(db, workspaceId, id, at)
      },
      createRun: (workspaceId, input) =>
        repository.createRun(db, workspaceId, input as unknown as CreateAiAgentRunInput),
      findRunById: (workspaceId, id) => repository.findRunById(db, workspaceId, id),
      listRuns: (workspaceId, query) =>
        repository.searchRuns(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          agentId: query.agentId,
          status: query.status,
        }),
      updateRun: (workspaceId, id, patch) =>
        repository.updateRun(db, workspaceId, id, patch as UpdateAiAgentRunInput),
    },
    provider: createOpenAiCompatibleAiProvider({
      baseUrl: env.AI_BASE_URL,
      apiKey: env.AI_API_KEY,
      model: env.AI_DEFAULT_MODEL,
      // Required: gateways reject unrecognised clients. See the provider.
      userAgent: env.AI_USER_AGENT,
      timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
    }),
    // The proposal port is the SAME governance service the approval queue
    // is served from — one gate, one audit trail, one policy resolution.
    tools: createAiAgentToolRegistry({
      readTools,
      proposals: createDefaultAiGovernanceService(),
    }),
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "ai" })
    },
    events: getEventBus(),
    queue: defaultQueue(),
    // PERMISSION INHERITANCE: the OWNER's role is read from memberships at
    // execution time, so a demotion or a removal takes effect on the very
    // next run.
    resolveActorRole: async (workspaceId, actorId) => {
      const memberships = await listMembershipsForUser(db, actorId)
      const membership = memberships.find((m) => m.workspaceId === workspaceId)
      return membership ? (membership.role ?? "viewer") : null
    },
  })
}

function serviceContextOf(c: Context<AppEnv>) {
  const session = c.get("session") as Session | null
  return {
    workspaceId: session?.workspaceId ?? "",
    actorId: session?.user.id ?? "",
    role: session ? roleInWorkspace(session) : "viewer",
    correlationId: c.get("requestId") as string | undefined,
  }
}

function mapError(c: Context<AppEnv>, err: unknown) {
  const requestId = c.get("requestId") as string | undefined
  if (err instanceof PermissionDeniedError) {
    return c.json(errorEnvelope("FORBIDDEN", err.message, requestId), 403)
  }
  const code = err instanceof Error ? (err as { code?: string }).code : undefined
  if (code === "NOT_FOUND") {
    return c.json(errorEnvelope("NOT_FOUND", (err as Error).message, requestId), 404)
  }
  if (code === "CONFLICT") {
    return c.json(errorEnvelope("CONFLICT", (err as Error).message, requestId), 409)
  }
  if (code === "AI_PROVIDER_NOT_CONFIGURED") {
    return c.json(errorEnvelope(code, (err as Error).message, requestId), 503)
  }
  if (
    code === "VALIDATION_ERROR" ||
    code === "INVALID_AI_AGENT" ||
    code === "AI_AGENT_WRITE_TOOL_NOT_ALLOWED"
  ) {
    return c.json(errorEnvelope("VALIDATION_ERROR", (err as Error).message, requestId), 400)
  }
  throw err
}

function invalidBody(c: Context, result: { error: { flatten(): unknown } }) {
  return c.json(
    errorEnvelope(
      "VALIDATION_ERROR",
      "Invalid request body",
      c.req.header("x-request-id") ?? undefined,
      result.error.flatten(),
    ),
    400,
  )
}

function invalidQuery(c: Context, result: { error: { flatten(): unknown } }) {
  return c.json(
    errorEnvelope(
      "VALIDATION_ERROR",
      "Invalid query parameters",
      c.req.header("x-request-id") ?? undefined,
      result.error.flatten(),
    ),
    400,
  )
}

export function createRoutes(deps: AiAgentsRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database
  // or the provider — registry and full-app tests mount every module
  // without a live Postgres or an API key.
  let cached: AiAgentService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  /** The server's own vocabulary, so the UI never hard-codes it. */
  app.get("/catalogue", requireSession(), (c) =>
    c.json({
      data: {
        statuses: [...AI_AGENT_STATUSES],
        triggerTypes: [...AI_AGENT_TRIGGER_TYPES],
        triggerEvents: [...AI_AGENT_TRIGGER_EVENTS],
        runStatuses: [...AI_AGENT_RUN_STATUSES],
        limits: {
          maxSteps: AI_AGENT_MAX_STEPS_CEILING,
          maxToolCalls: AI_AGENT_MAX_TOOL_CALLS_CEILING,
          maxTotalTokens: AI_AGENT_MAX_TOTAL_TOKENS_CEILING,
        },
      },
    }),
  )

  /* ---------------------------------- runs -------------------------------- */
  // Registered BEFORE `/:id`, or `/runs` would be read as an agent id.

  app.get(
    "/runs",
    requireSession(),
    zValidator("query", aiAgentRunQuerySchema, (result, c) => {
      if (!result.success) return invalidQuery(c, result)
    }),
    async (c) => {
      try {
        return c.json(await service().listRuns(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/runs/:runId", requireSession(), async (c) => {
    try {
      return c.json({ data: await service().getRun(serviceContextOf(c), c.req.param("runId")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  /* -------------------------------- agents -------------------------------- */

  app.get(
    "/",
    requireSession(),
    zValidator("query", aiAgentQuerySchema, (result, c) => {
      if (!result.success) return invalidQuery(c, result)
    }),
    async (c) => {
      try {
        return c.json(await service().list(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/",
    requireSession(),
    zValidator("json", createAiAgentSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const agent = await service().create(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: agent }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/:id", requireSession(), async (c) => {
    try {
      const detail = await service().get(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { ...detail.agent, runs: detail.runs } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateAiAgentSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const agent = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: agent })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/:id", requireSession(), async (c) => {
    try {
      await service().remove(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  /** Turning an agent on is its own decision, and its own permission. */
  app.post(
    "/:id/status",
    requireSession(),
    zValidator("json", setAiAgentStatusSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const agent = await service().setStatus(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: agent })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  /**
   * Queue a manual run. 202: the run is recorded and queued, and the
   * worker executes it — an LLM loop with a token budget does not belong
   * on an HTTP connection. Poll `/ai/agents/runs/:runId` for the outcome.
   */
  app.post(
    "/:id/run",
    requireSession(),
    zValidator("json", runAiAgentSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const run = await service().runNow(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: run }, 202)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get(
    "/:id/runs",
    requireSession(),
    zValidator("query", aiAgentRunQuerySchema, (result, c) => {
      if (!result.success) return invalidQuery(c, result)
    }),
    async (c) => {
      try {
        return c.json(
          await service().listRuns(serviceContextOf(c), {
            ...c.req.valid("query"),
            agentId: c.req.param("id"),
          }),
        )
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  return app
}

/**
 * Wake event-triggered agents from the in-process event bus. The
 * bootstrap (`apps/api/src/index.ts`) owns this call — route factories
 * must not subscribe, because route construction happens in tests that
 * emit unrelated events on the shared bus.
 */
export function subscribeAiAgentRuns(service?: AiAgentService): () => void {
  const bound = service ?? defaultService()
  return subscribeAiAgentDispatcher(getEventBus(), bound, (err, event) => {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "ai_agent_dispatch_failed",
        event: event.event,
        eventId: event.eventId,
        err: String(err),
      }),
    )
  })
}

export const openApiPaths = {
  "/api/v1/ai/agents": {
    get: { summary: "List AI agents", operationId: "listAiAgents" },
    post: {
      summary: "Create an AI agent (born disabled)",
      operationId: "createAiAgent",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createAiAgentSchema) } },
      },
    },
  },
  "/api/v1/ai/agents/catalogue": {
    get: {
      summary: "Agent statuses, trigger types, triggerable events and budget ceilings",
      operationId: "getAiAgentCatalogue",
    },
  },
  "/api/v1/ai/agents/runs": {
    get: {
      summary: "Run history across agents (filter by agent or status)",
      operationId: "listAiAgentRuns",
    },
  },
  "/api/v1/ai/agents/runs/{runId}": {
    get: {
      summary: "One run: steps, tool calls, proposals, tokens, latency and cost",
      operationId: "getAiAgentRun",
    },
  },
  "/api/v1/ai/agents/{id}": {
    get: { summary: "One agent with its recent runs", operationId: "getAiAgent" },
    patch: {
      summary: "Update an AI agent",
      operationId: "updateAiAgent",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateAiAgentSchema) } },
      },
    },
    delete: { summary: "Delete an AI agent", operationId: "deleteAiAgent" },
  },
  "/api/v1/ai/agents/{id}/status": {
    post: {
      summary: "Enable or disable an agent (requires run_ai)",
      operationId: "setAiAgentStatus",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(setAiAgentStatusSchema) } },
      },
    },
  },
  "/api/v1/ai/agents/{id}/run": {
    post: {
      summary: "Queue a manual run (202; poll the run for its outcome)",
      operationId: "runAiAgent",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(runAiAgentSchema) } },
      },
    },
  },
  "/api/v1/ai/agents/{id}/runs": {
    get: { summary: "One agent's run history", operationId: "listAiAgentRunsForAgent" },
  },
}

export { aiAgentEnvelope, aiAgentListEnvelope, aiAgentRunListEnvelope }
