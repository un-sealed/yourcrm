import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  connectIntegrationSchema,
  createGenericWebhookIntegrationProvider,
  createIntegrationProviderCatalog,
  createIntegrationsService,
  integrationConnectionQuerySchema,
  integrationConnectionSchema,
  integrationCredentialMetadataSchema,
  integrationProviderSummarySchema,
  integrationWebhookEventSchema,
  rotateIntegrationCredentialsSchema,
  updateIntegrationConnectionSchema,
  type IntegrationCredentialKindValue,
  type IntegrationProviderPort,
  type IntegrationsService,
} from "@yourcrm/crm/src/integrations"
import { getDb, writeAudit } from "@yourcrm/database"
import { createIntegrationsRepository } from "@yourcrm/database/src/repositories/integrations-repository"
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
 * Integrations module (spec 31-integrations, P0).
 *
 * Two very different surfaces live here:
 *
 * - `/integrations/**` — ADMIN. Session required, and the domain service
 *   gates every method on the `admin` action, so a member gets 403 even for
 *   reads.
 * - `POST /integrations/:connectionId/webhook` — PUBLIC. No session: the
 *   caller is the provider. Its authentication is the constant-time HMAC
 *   check inside the service, which runs before anything is read, written or
 *   dispatched. An unverified request gets 401 and leaves no trace.
 *
 * No response on either surface can carry a credential — the DTO schemas
 * have nowhere to put one (see `@yourcrm/crm/src/integrations/schemas.ts`).
 */

export const basePath = "/integrations"

const connectionEnvelope = z.object({ data: integrationConnectionSchema.passthrough() })
const connectionListEnvelope = paginatedEnvelopeSchema(integrationConnectionSchema.passthrough())
const connectionDetailEnvelope = z.object({
  data: z.object({
    connection: integrationConnectionSchema.passthrough(),
    credentials: z.array(integrationCredentialMetadataSchema.passthrough()),
    webhookEvents: z.array(integrationWebhookEventSchema.passthrough()),
    webhookPath: z.string().nullable(),
  }),
})
const providerListEnvelope = z.object({ data: z.array(integrationProviderSummarySchema) })

export type IntegrationsRouteDeps = {
  service?: IntegrationsService
  /** Providers this deployment exposes. Defaults to the built-ins below. */
  providers?: IntegrationProviderPort[]
}

/**
 * Providers available to this API process.
 *
 * BLOCKER (integrator): once `apps/api` declares `@yourcrm/integrations`,
 * replace this function body with
 *
 * ```ts
 * import { getIntegrationProviderRegistry } from "@yourcrm/integrations"
 * return getIntegrationProviderRegistry().list()
 * ```
 *
 * — the registry satisfies `IntegrationProviderCatalogPort` structurally, so
 * nothing else changes and vendor adapters become self-registering. Until
 * then bun does not symlink that package into `apps/api/node_modules`
 * (verified: TS2307) and the catalogue is this explicit list.
 */
function defaultIntegrationProviders(): IntegrationProviderPort[] {
  return [createGenericWebhookIntegrationProvider()]
}

function defaultService(providers: IntegrationProviderPort[]): IntegrationsService {
  const db = getDb()
  const repository = createIntegrationsRepository()
  return createIntegrationsService({
    providers: createIntegrationProviderCatalog(providers),
    store: {
      list: (workspaceId, query) =>
        repository.listConnections(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          providerId: query.providerId,
          status: query.status,
        }),
      findById: (workspaceId, id) => repository.findConnectionById(db, workspaceId, id),
      findForWebhook: (id) => repository.findConnectionForWebhook(db, id),
      create: (workspaceId, input, actorId) =>
        repository.createConnection(
          db,
          workspaceId,
          {
            providerId: String(input.providerId),
            displayName: String(input.displayName),
            status: typeof input.status === "string" ? input.status : undefined,
            authKind: typeof input.authKind === "string" ? input.authKind : undefined,
            config: (input.config as Record<string, unknown> | undefined) ?? {},
          },
          actorId,
        ),
      update: (workspaceId, id, patch, actorId) =>
        repository.updateConnection(db, workspaceId, id, patch, actorId),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDeleteConnection(db, workspaceId, id, actorId)
      },
    },
    credentials: {
      put: (workspaceId, input, actorId) =>
        repository.putCredential(db, workspaceId, input, actorId),
      listMetadata: (workspaceId, connectionId) =>
        repository.listCredentialMetadata(db, workspaceId, connectionId),
      readSecret: (workspaceId, connectionId, kind: IntegrationCredentialKindValue) =>
        repository.readCredentialSecret(db, workspaceId, connectionId, kind),
      delete: (workspaceId, connectionId, kind: IntegrationCredentialKindValue) =>
        repository.deleteCredential(db, workspaceId, connectionId, kind),
      deleteAll: (workspaceId, connectionId) =>
        repository.deleteCredentials(db, workspaceId, connectionId),
    },
    webhooks: {
      find: (connectionId, providerEventId) =>
        repository.findWebhookEvent(db, connectionId, providerEventId),
      record: (workspaceId, input) => repository.recordWebhookEvent(db, workspaceId, input),
      mark: async (workspaceId, id, status, patch) => {
        await repository.markWebhookEvent(db, workspaceId, id, status, patch)
      },
      list: (workspaceId, connectionId, limit) =>
        repository.listWebhookEvents(db, workspaceId, connectionId, limit),
    },
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

const STATUS_BY_CODE: Record<string, 400 | 401 | 403 | 404 | 500 | 501 | 502> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_IMPLEMENTED: 501,
  INTEGRATION_CONNECT_FAILED: 502,
  WEBHOOK_NOT_SUPPORTED: 400,
  WEBHOOK_HANDLER_FAILED: 500,
  CREDENTIAL_CRYPTO_ERROR: 500,
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
      // Provider-rejection reasons are already redacted by the service and
      // are what an admin needs to fix the connection, so they pass through.
      // Every other 5xx stays generic: internal detail is operator-only.
      const safeMessage = status < 500 || code === "INTEGRATION_CONNECT_FAILED"
      return c.json(
        errorEnvelope(code, safeMessage ? err.message : "Integration request failed", requestId),
        status,
      )
    }
  }
  throw err
}

/** Shared zValidator failure hook. `Context` stays ungenerified: the hook
 *  receives Hono's base context, not the app-typed one. */
function invalidBody(c: Context, details: unknown, what = "Invalid request body") {
  return c.json(
    errorEnvelope("VALIDATION_ERROR", what, c.req.header("x-request-id") ?? undefined, details),
    400,
  )
}

export function createRoutes(deps: IntegrationsRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database or
  // read ENCRYPTION_KEY — registry and full-app tests mount every module
  // without a live Postgres.
  let cached: IntegrationsService | null = deps.service ?? null
  const service = () => (cached ??= defaultService(deps.providers ?? defaultIntegrationProviders()))

  // Static path registered before "/:id" so it is never captured as an id.
  app.get("/providers", requireSession(), async (c) => {
    try {
      return c.json({ data: await service().listProviders(serviceContextOf(c)) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.get(
    "/",
    requireSession(),
    zValidator("query", integrationConnectionQuerySchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten(), "Invalid query parameters")
    }),
    async (c) => {
      try {
        return c.json(await service().listConnections(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/",
    requireSession(),
    zValidator("json", connectIntegrationSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten())
    }),
    async (c) => {
      try {
        const detail = await service().connect(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: detail }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/:id", requireSession(), async (c) => {
    try {
      return c.json({ data: await service().getConnection(serviceContextOf(c), c.req.param("id")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateIntegrationConnectionSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten())
    }),
    async (c) => {
      try {
        const connection = await service().updateConnection(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: connection })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/:id/credentials",
    requireSession(),
    zValidator("json", rotateIntegrationCredentialsSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten())
    }),
    async (c) => {
      try {
        const detail = await service().rotateCredentials(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: detail })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post("/:id/health", requireSession(), async (c) => {
    try {
      return c.json({ data: await service().checkHealth(serviceContextOf(c), c.req.param("id")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.delete("/:id", requireSession(), async (c) => {
    try {
      return c.json({ data: await service().disconnect(serviceContextOf(c), c.req.param("id")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  /**
   * Public inbound webhook. Deliberately NOT behind `requireSession()`:
   * the provider has no session, only the shared HMAC secret. The service
   * verifies that secret in constant time before touching anything, and an
   * unknown connection id fails identically to a bad signature so the
   * endpoint cannot be used to enumerate connections.
   */
  app.post("/:connectionId/webhook", async (c) => {
    const headers: Record<string, string> = {}
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    try {
      const result = await service().ingestWebhook({
        connectionId: c.req.param("connectionId"),
        headers,
        rawBody: await c.req.text(),
        correlationId: c.get("requestId") as string | undefined,
      })
      return c.json({ data: result }, result.status === "duplicate" ? 200 : 202)
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/integrations/providers": {
    get: {
      summary: "List registered integration providers (admin)",
      operationId: "listIntegrationProviders",
    },
  },
  "/api/v1/integrations": {
    get: {
      summary: "List integration connections (cursor pagination, admin)",
      operationId: "listIntegrationConnections",
    },
    post: {
      summary: "Connect an API-key integration (admin)",
      operationId: "connectIntegration",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(connectIntegrationSchema) } },
      },
    },
  },
  "/api/v1/integrations/{id}": {
    get: {
      summary: "Get a connection with credential metadata and recent deliveries (admin)",
      operationId: "getIntegrationConnection",
    },
    patch: {
      summary: "Rename a connection or change its config (admin)",
      operationId: "updateIntegrationConnection",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(updateIntegrationConnectionSchema) },
        },
      },
    },
    delete: {
      summary: "Disconnect and revoke every stored credential (admin)",
      operationId: "disconnectIntegration",
    },
  },
  "/api/v1/integrations/{id}/credentials": {
    post: {
      summary: "Rotate the API key and/or webhook secret (admin, write-only)",
      operationId: "rotateIntegrationCredentials",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(rotateIntegrationCredentialsSchema) },
        },
      },
    },
  },
  "/api/v1/integrations/{id}/health": {
    post: {
      summary: "Run a provider health check (admin)",
      operationId: "checkIntegrationHealth",
    },
  },
  "/api/v1/integrations/{connectionId}/webhook": {
    post: {
      summary: "Inbound provider webhook — HMAC signed, no session, idempotent",
      operationId: "ingestIntegrationWebhook",
    },
  },
}

export {
  connectionDetailEnvelope,
  connectionEnvelope,
  connectionListEnvelope,
  providerListEnvelope,
}
