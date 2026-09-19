import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createConsoleEmailProvider,
  createEmailService,
  emailAttachmentSchema,
  emailMessageSchema,
  emailParticipantSchema,
  emailThreadQuerySchema,
  emailThreadSchema,
  sendEmailMessageSchema,
  updateEmailThreadSchema,
  type EmailOutboundConnectionRecord,
  type EmailService,
  type EmailTransportPort,
} from "@yourcrm/crm/src/email"
import { getDb, writeAudit } from "@yourcrm/database"
import {
  createEmailRepository,
  type CreateEmailMessageInput,
  type CreateEmailThreadInput,
  type UpdateEmailMessageInput,
  type UpdateEmailThreadInput,
} from "@yourcrm/database/src/repositories/email-repository"
import { createIntegrationsRepository } from "@yourcrm/database/src/repositories/integrations-repository"
import { getEventBus } from "@yourcrm/events"
import { defineIntegrationProvider, getIntegrationProviderRegistry } from "@yourcrm/integrations"
import type { IntegrationProvider } from "@yourcrm/integrations"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * Email module (spec 14-email, P0). Thin HTTP layer only: zod validation at
 * the boundary, session from the auth middleware, then straight into the
 * domain service. No business logic here.
 *
 * THERE IS NO WEBHOOK ROUTE IN THIS FILE, ON PURPOSE. Inbound email arrives
 * on the connector framework's single public endpoint,
 * `POST /api/v1/integrations/:connectionId/webhook`, which verifies the HMAC
 * in constant time and de-duplicates on the provider event id before
 * dispatching to the email provider's `handle()`. A second ingress would be
 * a second thing to get wrong.
 *
 * Sending requires `send_external` (enforced in the service, not here).
 */

export const basePath = "/email"

const threadEnvelope = z.object({ data: emailThreadSchema.passthrough() })
const threadListEnvelope = paginatedEnvelopeSchema(emailThreadSchema.passthrough())
const messageDetailSchema = z.object({
  message: emailMessageSchema.passthrough(),
  participants: z.array(emailParticipantSchema.passthrough()),
  attachments: z.array(emailAttachmentSchema.passthrough()),
})
const messageEnvelope = z.object({ data: messageDetailSchema })
const threadDetailEnvelope = z.object({
  data: z.object({
    thread: emailThreadSchema.passthrough(),
    messages: z.array(messageDetailSchema),
  }),
})

export type EmailRouteDeps = {
  service?: EmailService
}

/** A registered provider that can also put mail on the wire. */
function emailTransportOf(provider: IntegrationProvider | null): EmailTransportPort | null {
  if (!provider) return null
  const candidate = provider as unknown as { sendEmail?: unknown }
  if (typeof candidate.sendEmail !== "function") return null
  return provider as unknown as EmailTransportPort
}

/**
 * Process-wide email service for machine callers (the inbound webhook). The
 * HTTP handlers use their own lazily-built instance, or an injected fake.
 */
let moduleService: EmailService | null = null
const resolveModuleService = (): EmailService => (moduleService ??= defaultService())

function defaultService(): EmailService {
  const db = getDb()
  const repository = createEmailRepository()
  const integrations = createIntegrationsRepository()
  const registry = getIntegrationProviderRegistry()

  /** Provider ids that declared `email.send`, resolved per call. */
  const sendableProviderIds = (): Set<string> =>
    new Set(registry.byCapability("email.send").map((provider) => provider.id))

  return createEmailService({
    threads: {
      list: (workspaceId, query) =>
        repository.searchThreads(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          status: query.status,
          personId: query.personId,
          companyId: query.companyId,
          dealId: query.dealId,
        }),
      findById: (workspaceId, id) => repository.findThreadById(db, workspaceId, id),
      findWithMessages: (workspaceId, id) => repository.findThreadWithMessages(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.createThread(
          db,
          workspaceId,
          input as unknown as CreateEmailThreadInput,
          actorId,
        ),
      update: (workspaceId, id, patch, actorId) =>
        repository.updateThread(
          db,
          workspaceId,
          id,
          patch as unknown as UpdateEmailThreadInput,
          actorId,
        ),
      refreshCounters: (workspaceId, threadId, lastMessageAt) =>
        repository.refreshThreadCounters(db, workspaceId, threadId, lastMessageAt),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDelete(db, workspaceId, id, actorId)
      },
      findThreadIdsByMessageIds: (workspaceId, messageIds) =>
        repository.findThreadIdsByMessageIds(db, workspaceId, messageIds),
      findThreadByMatch: (workspaceId, match) =>
        repository.findThreadByMatch(db, workspaceId, match),
    },
    messages: {
      create: (workspaceId, input, actorId) =>
        repository.createMessage(
          db,
          workspaceId,
          input as unknown as CreateEmailMessageInput,
          actorId,
        ),
      update: (workspaceId, id, patch, actorId) =>
        repository.updateMessage(
          db,
          workspaceId,
          id,
          patch as unknown as UpdateEmailMessageInput,
          actorId,
        ),
      findById: (workspaceId, id) => repository.findMessageById(db, workspaceId, id),
      findByMessageId: (workspaceId, messageId) =>
        repository.findMessageByMessageId(db, workspaceId, messageId),
      findWithDetail: (workspaceId, id) => repository.findMessageWithDetail(db, workspaceId, id),
    },
    connections: {
      findSendable: async (workspaceId, connectionId) => {
        const sendable = sendableProviderIds()
        const toRecord = (row: {
          id: string
          providerId: string
          status: string
          config: Record<string, unknown>
        }): EmailOutboundConnectionRecord | null => {
          if (row.status !== "connected" || !sendable.has(row.providerId)) return null
          return { id: row.id, providerId: row.providerId, config: row.config }
        }
        if (connectionId !== null && connectionId !== undefined) {
          const row = await integrations.findConnectionById(db, workspaceId, connectionId)
          return row ? toRecord(row) : null
        }
        // No connection named: the workspace's first connected email
        // integration. Multi-mailbox routing (send-as, shared mailboxes) is
        // P1 — the API already accepts an explicit connectionId for it.
        const listed = await integrations.listConnections(db, {
          workspaceId,
          limit: 50,
          status: "connected",
        })
        for (const row of listed.data) {
          const record = toRecord(row)
          if (record) return record
        }
        return null
      },
    },
    secrets: {
      // The ONE path from sealed storage to plaintext. The service hands the
      // value straight to the provider adapter and never stores it.
      readApiKey: (workspaceId, connectionId) =>
        integrations.readCredentialSecret(db, workspaceId, connectionId, "api_key"),
    },
    transports: { get: (providerId) => emailTransportOf(registry.get(providerId)) },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
    events: getEventBus(),
  })
}

/**
 * REGISTER THE EMAIL ADAPTER AT IMPORT TIME.
 *
 * This is the pattern `packages/integrations/README.md` prescribes for
 * adapter modules, and it is the only module-scope statement in this file:
 * building the provider is pure, and the email service behind its webhook
 * handler (and therefore `getDb()`) resolves on the first delivery, not
 * here. Route construction stays side-effect free.
 *
 * `defineIntegrationProvider` validates the id and the capability list at
 * import time rather than on the first connect attempt. The cast bridges
 * the structural mirror in `@yourcrm/crm/src/integrations/types.ts` to the
 * canonical contract — identical shapes, see that file's header.
 *
 * INTEGRATOR: `defaultIntegrationProviders()` in
 * `apps/api/src/routes/modules/integrations.ts` still returns a hardcoded
 * list instead of the registry. That file's own header already specifies
 * the replacement now that `apps/api` declares `@yourcrm/integrations`:
 *
 * ```ts
 * return getIntegrationProviderRegistry().list()
 * ```
 *
 * Until that one line lands, this provider is registered but absent from
 * the catalogue, so an email connection cannot be created through the API
 * and inbound webhooks have nothing to resolve. That file belongs to the
 * integrations module, so this agent did not edit it.
 */
function registerEmailProviders(): void {
  const registry = getIntegrationProviderRegistry()
  const consoleProvider = createConsoleEmailProvider({
    onInboundEmail: (input) => resolveModuleService().receiveInboundEmail(input),
  })
  // Idempotent: a duplicate id means the module graph was evaluated twice
  // (hot reload, a test importing this file alongside another), which is
  // not worth crashing module load over.
  if (registry.has(consoleProvider.id)) return
  registry.register(defineIntegrationProvider(consoleProvider as unknown as IntegrationProvider))
}

registerEmailProviders()

function serviceContextOf(c: Context<AppEnv>) {
  const session = c.get("session") as Session | null
  return {
    workspaceId: session?.workspaceId ?? "",
    actorId: session?.user.id ?? "",
    role: session ? roleInWorkspace(session) : "viewer",
    correlationId: c.get("requestId") as string | undefined,
  }
}

const STATUS_BY_CODE: Record<string, 400 | 403 | 404 | 422 | 500 | 502> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  EMAIL_CONNECTION_UNAVAILABLE: 422,
  EMAIL_SEND_FAILED: 502,
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
    if (code && status) {
      // Provider-rejection reasons are already redacted by the service
      // (`redactIntegrationSecrets`) and are what a user needs to fix the
      // send, so they pass through.
      return c.json(errorEnvelope(code, err.message, requestId), status)
    }
  }
  throw err
}

/** Shared zValidator failure hook. */
function invalidBody(c: Context, details: unknown, what = "Invalid request body") {
  return c.json(
    errorEnvelope("VALIDATION_ERROR", what, c.req.header("x-request-id") ?? undefined, details),
    400,
  )
}

export function createRoutes(deps: EmailRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  let cached: EmailService | null = deps.service ?? null
  const service = () => (cached ??= resolveModuleService())

  app.get(
    "/threads",
    requireSession(),
    zValidator("query", emailThreadQuerySchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten(), "Invalid query parameters")
    }),
    async (c) => {
      try {
        return c.json(await service().listThreads(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/threads/:id", requireSession(), async (c) => {
    try {
      return c.json({ data: await service().getThread(serviceContextOf(c), c.req.param("id")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.patch(
    "/threads/:id",
    requireSession(),
    zValidator("json", updateEmailThreadSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten())
    }),
    async (c) => {
      try {
        const thread = await service().updateThread(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: thread })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/threads/:id", requireSession(), async (c) => {
    try {
      await service().deleteThread(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.get("/messages/:id", requireSession(), async (c) => {
    try {
      return c.json({ data: await service().getMessage(serviceContextOf(c), c.req.param("id")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  /** Compose + send. The service gates this on `send_external`. */
  app.post(
    "/messages",
    requireSession(),
    zValidator("json", sendEmailMessageSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten())
    }),
    async (c) => {
      try {
        const sent = await service().sendMessage(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: sent }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  return app
}

export const openApiPaths = {
  "/api/v1/email/threads": {
    get: {
      summary: "List email threads (cursor pagination, search, record filters)",
      operationId: "listEmailThreads",
    },
  },
  "/api/v1/email/threads/{id}": {
    get: {
      summary: "Get an email thread with its messages, participants and attachments",
      operationId: "getEmailThread",
    },
    patch: {
      summary: "Link an email thread to a person/company/deal, rename or archive it",
      operationId: "updateEmailThread",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateEmailThreadSchema) } },
      },
    },
    delete: { summary: "Soft-delete an email thread", operationId: "deleteEmailThread" },
  },
  "/api/v1/email/messages": {
    post: {
      summary: "Send an email through the workspace's email integration (send_external)",
      operationId: "sendEmailMessage",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(sendEmailMessageSchema) } },
      },
    },
  },
  "/api/v1/email/messages/{id}": {
    get: {
      summary: "Get one email message with participants and attachment metadata",
      operationId: "getEmailMessage",
    },
  },
}

export { messageEnvelope, threadDetailEnvelope, threadEnvelope, threadListEnvelope }
