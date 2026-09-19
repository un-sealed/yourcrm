import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createWhatsAppConsoleProvider,
  createWhatsAppService,
  createWhatsAppConversationSchema,
  createWhatsAppTemplateSchema,
  sendWhatsAppMessageSchema,
  updateWhatsAppConversationSchema,
  whatsAppConversationQuerySchema,
  whatsAppConversationSchema,
  whatsAppMessageQuerySchema,
  whatsAppMessageSchema,
  whatsAppTemplateSchema,
  type WhatsAppService,
} from "@yourcrm/crm/src/whatsapp"
import { getDb, writeAudit } from "@yourcrm/database"
import { createIntegrationsRepository } from "@yourcrm/database/src/repositories/integrations-repository"
import {
  createWhatsAppRepository,
  type CreateWhatsAppConversationInput,
  type CreateWhatsAppMessageInput,
  type CreateWhatsAppTemplateInput,
  type UpdateWhatsAppConversationInput,
} from "@yourcrm/database/src/repositories/whatsapp-repository"
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
 * WhatsApp module (spec 16-whatsapp, P0).
 *
 * Thin HTTP layer only — validation, session, straight into the domain
 * service (`@yourcrm/crm/src/whatsapp`), same layering as every other
 * module route (`people.ts` is the golden reference).
 *
 * INBOUND WEBHOOKS deliberately have NO route here. Per the integrations
 * framework contract, there is exactly one webhook endpoint in the whole
 * app — `POST /api/v1/integrations/:connectionId/webhook`, owned by
 * `./integrations.ts` — which resolves the connection's provider and calls
 * its `webhook.handle`. This module's provider
 * (`createWhatsAppConsoleProvider`, below) is NOT yet in that route's
 * `defaultIntegrationProviders()` list; see the "WIRING GAP" note in
 * `packages/crm/src/whatsapp/providers/console-provider.ts` for the exact
 * one-line change that closes it. Until then, inbound processing
 * (`service.ingestInboundMessage` / `ingestStatusUpdate`) is fully covered
 * by unit tests but not reachable from a live HTTP request.
 */

export const basePath = "/whatsapp"

const conversationEnvelope = z.object({ data: whatsAppConversationSchema.passthrough() })
const conversationListEnvelope = paginatedEnvelopeSchema(whatsAppConversationSchema.passthrough())
const messageEnvelope = z.object({ data: whatsAppMessageSchema.passthrough() })
const messageListEnvelope = paginatedEnvelopeSchema(whatsAppMessageSchema.passthrough())
const templateEnvelope = z.object({ data: whatsAppTemplateSchema.passthrough() })
const templateListEnvelope = paginatedEnvelopeSchema(whatsAppTemplateSchema.passthrough())

export type WhatsAppRouteDeps = {
  service?: WhatsAppService
}

/**
 * Default provider wiring: the dev/console provider, so `POST
 * /conversations/:id/messages` works with zero real credentials once a
 * `whatsapp-console` connection is installed via `/api/v1/integrations`
 * (spec requirement: "the module must be fully testable with no real
 * credentials"). A real Meta Cloud API adapter would be registered the same
 * way, selected by the connection's `providerId`.
 */
function defaultService(): WhatsAppService {
  const db = getDb()
  const repository = createWhatsAppRepository()
  const integrations = createIntegrationsRepository()
  const provider = createWhatsAppConsoleProvider()

  return createWhatsAppService({
    conversations: {
      list: (workspaceId, query) => repository.listConversations(db, { workspaceId, ...query }),
      findById: (workspaceId, id) => repository.findConversationById(db, workspaceId, id),
      findOrCreate: async (workspaceId, input, actorId) => {
        const { row, created } = await repository.findOrCreateConversation(
          db,
          workspaceId,
          input as unknown as CreateWhatsAppConversationInput,
          actorId,
        )
        return { record: row, created }
      },
      update: (workspaceId, id, patch, actorId) =>
        repository.updateConversation(
          db,
          workspaceId,
          id,
          patch as UpdateWhatsAppConversationInput,
          actorId,
        ),
      touchInbound: (workspaceId, conversationId, occurredAt, preview) =>
        repository.touchInbound(db, workspaceId, conversationId, occurredAt, preview),
      touchOutbound: (workspaceId, conversationId, occurredAt, preview) =>
        repository.touchOutbound(db, workspaceId, conversationId, occurredAt, preview),
      markRead: (workspaceId, conversationId) =>
        repository.markConversationRead(db, workspaceId, conversationId),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDeleteConversation(db, workspaceId, id, actorId)
      },
    },
    messages: {
      list: (workspaceId, conversationId, opts) =>
        repository.listMessages(db, workspaceId, conversationId, opts),
      findById: (workspaceId, id) => repository.findMessageById(db, workspaceId, id),
      findByProviderMessageId: (workspaceId, providerMessageId) =>
        repository.findByProviderMessageId(db, workspaceId, providerMessageId),
      create: (workspaceId, input, actorId) =>
        repository.createMessage(db, workspaceId, input as CreateWhatsAppMessageInput, actorId),
      update: (workspaceId, id, patch) =>
        repository.updateMessageById(
          db,
          workspaceId,
          id,
          patch as {
            providerMessageId?: string | null
            status?: string
            error?: string | null
            occurredAt?: Date
          },
        ),
      recordInbound: async (workspaceId, input, actorId) => {
        const { row, created } = await repository.recordInboundMessage(
          db,
          workspaceId,
          input as CreateWhatsAppMessageInput,
          actorId,
        )
        return { record: row, created }
      },
      applyStatus: async (workspaceId, providerMessageId, status, patch) => {
        const result = await repository.applyMessageStatus(
          db,
          workspaceId,
          providerMessageId,
          status,
          patch,
        )
        return result ? { record: result.row, applied: result.applied } : null
      },
    },
    templates: {
      list: (workspaceId, opts) => repository.listTemplates(db, workspaceId, opts),
      findById: (workspaceId, id) => repository.findTemplateById(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.createTemplate(db, workspaceId, input as CreateWhatsAppTemplateInput, actorId),
    },
    connections: {
      findById: async (workspaceId, connectionId) => {
        const row = await integrations.findConnectionById(db, workspaceId, connectionId)
        if (!row) return null
        return {
          id: row.id,
          workspaceId: row.workspaceId,
          providerId: row.providerId,
          status: row.status,
          config: row.config,
        }
      },
      readSecret: (workspaceId, connectionId) =>
        integrations.readCredentialSecret(db, workspaceId, connectionId, "api_key"),
    },
    provider,
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
    events: getEventBus(),
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

const STATUS_BY_CODE: Record<string, 400 | 403 | 404 | 409 | 500 | 502> = {
  NOT_FOUND: 404,
  WHATSAPP_SESSION_WINDOW_CLOSED: 409,
  TEMPLATE_NOT_APPROVED: 409,
  WHATSAPP_NOT_CONNECTED: 409,
  WHATSAPP_SEND_FAILED: 502,
}

function mapError(c: Context<AppEnv>, err: unknown) {
  const requestId = c.get("requestId") as string | undefined
  if (err instanceof PermissionDeniedError) {
    return c.json(errorEnvelope("FORBIDDEN", err.message, requestId), 403)
  }
  if (err instanceof z.ZodError) {
    return c.json(
      errorEnvelope("VALIDATION_ERROR", "Invalid request body", requestId, err.flatten()),
      400,
    )
  }
  if (err instanceof Error) {
    const code = (err as { code?: string }).code
    const status = code ? STATUS_BY_CODE[code] : undefined
    if (code && status) return c.json(errorEnvelope(code, err.message, requestId), status)
  }
  throw err
}

function invalidBody(c: Context, details: unknown, what = "Invalid request body") {
  return c.json(
    errorEnvelope("VALIDATION_ERROR", what, c.req.header("x-request-id") ?? undefined, details),
    400,
  )
}

export function createRoutes(deps: WhatsAppRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  let cached: WhatsAppService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/conversations",
    requireSession(),
    zValidator("query", whatsAppConversationQuerySchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten(), "Invalid query parameters")
    }),
    async (c) => {
      try {
        return c.json(await service().listConversations(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/conversations",
    requireSession(),
    zValidator("json", createWhatsAppConversationSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten())
    }),
    async (c) => {
      try {
        const conversation = await service().createConversation(
          serviceContextOf(c),
          c.req.valid("json"),
        )
        return c.json({ data: conversation }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/conversations/:id", requireSession(), async (c) => {
    try {
      const conversation = await service().getConversation(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: conversation })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.patch(
    "/conversations/:id",
    requireSession(),
    zValidator("json", updateWhatsAppConversationSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten())
    }),
    async (c) => {
      try {
        const conversation = await service().updateConversation(
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

  app.post("/conversations/:id/read", requireSession(), async (c) => {
    try {
      const conversation = await service().markConversationRead(
        serviceContextOf(c),
        c.req.param("id"),
      )
      return c.json({ data: conversation })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.get(
    "/conversations/:id/messages",
    requireSession(),
    zValidator("query", whatsAppMessageQuerySchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten(), "Invalid query parameters")
    }),
    async (c) => {
      try {
        const result = await service().listMessages(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("query"),
        )
        return c.json(result)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  /**
   * Send an outbound message. `kind: "text"` is rejected with
   * `WHATSAPP_SESSION_WINDOW_CLOSED` (409) outside the 24h session window —
   * the client should fall back to prompting for a template, not retry.
   */
  app.post(
    "/conversations/:id/messages",
    requireSession(),
    zValidator("json", sendWhatsAppMessageSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten())
    }),
    async (c) => {
      try {
        const message = await service().sendMessage(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: message }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/templates", requireSession(), async (c) => {
    try {
      const connectionId = c.req.query("connectionId")
      const result = await service().listTemplates(serviceContextOf(c), connectionId)
      return c.json(result)
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/templates",
    requireSession(),
    zValidator("json", createWhatsAppTemplateSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten())
    }),
    async (c) => {
      try {
        const template = await service().createTemplate(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: template }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  return app
}

export const openApiPaths = {
  "/api/v1/whatsapp/conversations": {
    get: {
      summary: "List WhatsApp conversations (cursor pagination, filters)",
      operationId: "listWhatsAppConversations",
    },
    post: {
      summary: "Open (or return the existing) conversation for a contact phone number",
      operationId: "createWhatsAppConversation",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(createWhatsAppConversationSchema) },
        },
      },
    },
  },
  "/api/v1/whatsapp/conversations/{id}": {
    get: { summary: "Get a WhatsApp conversation", operationId: "getWhatsAppConversation" },
    patch: {
      summary: "Link a conversation to a person/company or change its status",
      operationId: "updateWhatsAppConversation",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(updateWhatsAppConversationSchema) },
        },
      },
    },
  },
  "/api/v1/whatsapp/conversations/{id}/read": {
    post: { summary: "Mark a conversation read", operationId: "markWhatsAppConversationRead" },
  },
  "/api/v1/whatsapp/conversations/{id}/messages": {
    get: {
      summary: "List messages in a conversation (cursor pagination)",
      operationId: "listWhatsAppMessages",
    },
    post: {
      summary:
        "Send an outbound message (requires send_external; free text is rejected outside the 24h session window)",
      operationId: "sendWhatsAppMessage",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(sendWhatsAppMessageSchema) } },
      },
    },
  },
  "/api/v1/whatsapp/templates": {
    get: { summary: "List WhatsApp templates", operationId: "listWhatsAppTemplates" },
    post: {
      summary: "Register a template",
      operationId: "createWhatsAppTemplate",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createWhatsAppTemplateSchema) } },
      },
    },
  },
}

export {
  conversationEnvelope,
  conversationListEnvelope,
  messageEnvelope,
  messageListEnvelope,
  templateEnvelope,
  templateListEnvelope,
}
