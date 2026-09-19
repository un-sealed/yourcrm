import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import { loadEnv } from "@yourcrm/config"
import {
  aiConversationQuerySchema,
  aiConversationSchema,
  aiMessageSchema,
  aiProviderStatusSchema,
  aiRunSchema,
  askAiSchema,
  createAiAssistantService,
  createAiConversationSchema,
  createAiCrmTools,
  createOpenAiCompatibleAiProvider,
  updateAiConversationSchema,
  type AiAssistantService,
} from "@yourcrm/crm/src/ai-assistant"
import { getDb, writeAudit } from "@yourcrm/database"
import {
  createAiRepository,
  type AppendAiMessageInput,
  type RecordAiRunInput,
} from "@yourcrm/database/src/repositories/ai-repository"
import {
  createReportsRepository,
  describeReportObjects,
  type ReportExecutionRequest,
  type ReportRowScope,
} from "@yourcrm/database/src/repositories/reports-repository"
import { getEventBus } from "@yourcrm/events"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * AI assistant module — Ask Your CRM (spec 34-ai-assistant, P0).
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. The interesting
 * guarantees all live in `@yourcrm/crm/src/ai-assistant`:
 *
 *  - tools execute under the caller's `ServiceContext`, so an answer can
 *    never contain a record the asker could not read;
 *  - P0 is read-only — no route here can cause a CRM write;
 *  - every run and tool call is audited with `source: "ai"` and a run id.
 *
 * Answers are returned whole (no SSE in P0). The provider port has room
 * for a streaming variant; the chat UI renders a pending state meanwhile.
 */

export const basePath = "/ai"

const conversationEnvelope = z.object({ data: aiConversationSchema.passthrough() })
const conversationListEnvelope = paginatedEnvelopeSchema(aiConversationSchema.passthrough())
const conversationDetailEnvelope = z.object({
  data: z.object({
    conversation: aiConversationSchema.passthrough(),
    messages: z.array(aiMessageSchema.passthrough()),
    runs: z.array(aiRunSchema.passthrough()),
  }),
})
const askEnvelope = z.object({
  data: z.object({
    conversation: aiConversationSchema.passthrough(),
    userMessage: aiMessageSchema.passthrough(),
    assistantMessage: aiMessageSchema.passthrough(),
    run: aiRunSchema.passthrough(),
    toolCalls: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        outcome: z.string(),
        summary: z.string(),
        durationMs: z.number(),
      }),
    ),
  }),
})
const providerStatusEnvelope = z.object({ data: aiProviderStatusSchema })

export type AiRouteDeps = {
  service?: AiAssistantService
}

/**
 * Composition root for the assistant.
 *
 * The provider is built from validated env (`@yourcrm/config`). The tool
 * set is handed the *reports* repository — the assistant answers questions
 * through the same allowlisted, row-scoped query engine the reports module
 * uses, never through SQL of its own.
 */
function defaultService(): AiAssistantService {
  const db = getDb()
  const env = loadEnv()
  const repository = createAiRepository()
  const reports = createReportsRepository()

  if (!env.AI_API_KEY || !env.AI_DEFAULT_MODEL) {
    throw new AiNotConfiguredError()
  }

  return createAiAssistantService({
    store: {
      listConversations: (workspaceId, query, scope) =>
        repository.listConversations(db, {
          workspaceId,
          scope,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
        }),
      findConversation: (workspaceId, id) => repository.findConversation(db, workspaceId, id),
      createConversation: (workspaceId, input, actorId) =>
        repository.createConversation(db, workspaceId, input, actorId),
      updateConversation: (workspaceId, id, patch, actorId) =>
        repository.updateConversation(db, workspaceId, id, patch, actorId),
      softDeleteConversation: async (workspaceId, id, actorId) => {
        await repository.softDeleteConversation(db, workspaceId, id, actorId)
      },
      listMessages: (workspaceId, conversationId, limit) =>
        repository.listMessages(db, workspaceId, conversationId, limit),
      appendMessage: (workspaceId, input, actorId) =>
        repository.appendMessage(db, workspaceId, input as AppendAiMessageInput, actorId),
      recordRun: (workspaceId, input, actorId) =>
        repository.recordRun(db, workspaceId, input as RecordAiRunInput, actorId),
      listRuns: (workspaceId, conversationId, limit) =>
        repository.listRuns(db, workspaceId, conversationId, limit),
    },
    provider: createOpenAiCompatibleAiProvider({
      baseUrl: env.AI_BASE_URL,
      apiKey: env.AI_API_KEY,
      model: env.AI_DEFAULT_MODEL,
      // Required: gateways reject unrecognised clients. See the provider.
      userAgent: env.AI_USER_AGENT,
      timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
    }),
    tools: createAiCrmTools({
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
    }),
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "ai" })
    },
    events: getEventBus(),
  })
}

/** Raised by the composition root, mapped to 503 — never leaks the key. */
class AiNotConfiguredError extends Error {
  readonly code = "AI_PROVIDER_NOT_CONFIGURED"
  constructor() {
    super("the AI provider is not configured (set AI_API_KEY and AI_DEFAULT_MODEL)")
    this.name = "AiNotConfiguredError"
  }
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

const PROVIDER_STATUS: Record<string, 502 | 503 | 504> = {
  AI_PROVIDER_NOT_CONFIGURED: 503,
  AI_PROVIDER_UNAUTHORIZED: 503,
  AI_PROVIDER_TIMEOUT: 504,
  AI_PROVIDER_RATE_LIMITED: 502,
  AI_PROVIDER_UNAVAILABLE: 502,
  AI_PROVIDER_INVALID_RESPONSE: 502,
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
  if (code !== undefined && code in PROVIDER_STATUS) {
    // Provider messages are redacted at the provider; safe to surface.
    return c.json(
      errorEnvelope(code, (err as Error).message, requestId),
      PROVIDER_STATUS[code] ?? 502,
    )
  }
  if (code === "INVALID_REPORT" || code === "AI_WRITE_TOOL_NOT_ALLOWED") {
    return c.json(errorEnvelope("VALIDATION_ERROR", (err as Error).message, requestId), 400)
  }
  throw err
}

/** Shared 400 body for the zValidator hooks (hook contexts are generic). */
function invalidBody(c: Context, message: string, details: unknown) {
  return c.json(
    errorEnvelope("VALIDATION_ERROR", message, c.req.header("x-request-id") ?? undefined, details),
    400,
  )
}

export function createRoutes(deps: AiRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database
  // or read credentials — registry and full-app tests mount every module.
  let cached: AiAssistantService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  // Registered before `/conversations/:id` cannot clash (different prefix),
  // but kept first so the non-secret status endpoint is easy to find.
  app.get("/provider", requireSession(), (c) => {
    try {
      return c.json({ data: service().describeProvider(serviceContextOf(c)) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.get(
    "/conversations",
    requireSession(),
    zValidator("query", aiConversationQuerySchema, (result, c) => {
      if (!result.success) {
        return invalidBody(c, "Invalid query parameters", result.error.flatten())
      }
    }),
    async (c) => {
      try {
        const result = await service().listConversations(serviceContextOf(c), c.req.valid("query"))
        return c.json(result)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/conversations",
    requireSession(),
    zValidator("json", createAiConversationSchema.optional(), (result, c) => {
      if (!result.success) {
        return invalidBody(c, "Invalid request body", result.error.flatten())
      }
    }),
    async (c) => {
      try {
        const conversation = await service().createConversation(
          serviceContextOf(c),
          c.req.valid("json") ?? {},
        )
        return c.json({ data: conversation }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/conversations/:id", requireSession(), async (c) => {
    try {
      const detail = await service().getConversation(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: detail })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.patch(
    "/conversations/:id",
    requireSession(),
    zValidator("json", updateAiConversationSchema, (result, c) => {
      if (!result.success) {
        return invalidBody(c, "Invalid request body", result.error.flatten())
      }
    }),
    async (c) => {
      try {
        const conversation = await service().renameConversation(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: conversation })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/conversations/:id", requireSession(), async (c) => {
    try {
      await service().deleteConversation(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  /**
   * Ask a question. Creates the conversation when `conversationId` is
   * omitted. Tools run under this caller's permissions, so the same
   * question can legitimately return different answers to different users.
   */
  app.post(
    "/chat",
    requireSession(),
    zValidator("json", askAiSchema, (result, c) => {
      if (!result.success) {
        return invalidBody(c, "Invalid request body", result.error.flatten())
      }
    }),
    async (c) => {
      try {
        const result = await service().ask(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: result })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  return app
}

export const openApiPaths = {
  "/api/v1/ai/provider": {
    get: {
      summary: "Describe the configured AI provider, model and read-only tools (no secrets)",
      operationId: "getAiProvider",
    },
  },
  "/api/v1/ai/conversations": {
    get: {
      summary: "List the calling user's AI conversations",
      operationId: "listAiConversations",
    },
    post: {
      summary: "Start an AI conversation",
      operationId: "createAiConversation",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createAiConversationSchema) } },
      },
    },
  },
  "/api/v1/ai/conversations/{id}": {
    get: {
      summary: "Get one conversation with its transcript and runs",
      operationId: "getAiConversation",
    },
    patch: {
      summary: "Rename a conversation",
      operationId: "renameAiConversation",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateAiConversationSchema) } },
      },
    },
    delete: { summary: "Delete a conversation", operationId: "deleteAiConversation" },
  },
  "/api/v1/ai/chat": {
    post: {
      summary:
        "Ask the assistant a question. Read-only: tools execute with the caller's permissions and the answer never exposes records the caller cannot read",
      operationId: "askAi",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(askAiSchema) } },
      },
    },
  },
}

export {
  askEnvelope,
  conversationDetailEnvelope,
  conversationEnvelope,
  conversationListEnvelope,
  providerStatusEnvelope,
}
