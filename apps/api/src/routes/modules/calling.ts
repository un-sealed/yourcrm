import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  addCallRecordingSchema,
  AmbiguousCallingConnectionError,
  CallingConnectionNotConnectedError,
  CallingConnectionNotFoundError,
  CallingProviderCallFailedError,
  CallingProviderNotRegisteredError,
  CallNotFoundError,
  callQuerySchema,
  callRecordingSchema,
  callSchema,
  createCallingProviderCatalog,
  createCallingService,
  createConsoleCallingProvider,
  logCallSchema,
  MissingCallerIdError,
  NoCallingProviderConnectedError,
  placeCallSchema,
  RecordingConsentRequiredError,
  updateCallSchema,
  type CallingService,
} from "@yourcrm/crm/src/calling"
import { getDb, writeAudit } from "@yourcrm/database"
import { createCallingRepository } from "@yourcrm/database/src/repositories/calling-repository"
import type {
  CreateCallInput,
  UpdateCallInput,
} from "@yourcrm/database/src/repositories/calling-repository"
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
 * Calling module (spec 17-calling, P0).
 *
 * Manual call logging needs no provider at all. Click-to-call
 * (`POST /calling/place`) resolves a connected calling provider through the
 * SAME `integration_connections`/`integration_credentials` tables the
 * integrations module owns (read-only here — connecting/rotating a
 * provider's credential stays that module's job) and asks it to place the
 * call; the provider's status webhook is delivered through the shared
 * `POST /api/v1/integrations/:connectionId/webhook` endpoint the
 * integrations module already exposes — this file does NOT add a second
 * webhook endpoint.
 *
 * BLOCKER (integrator) — see the package README note below.
 */

export const basePath = "/calling"

const callEnvelope = z.object({ data: callSchema.passthrough() })
const callListEnvelope = paginatedEnvelopeSchema(callSchema.passthrough())
const callDetailEnvelope = z.object({
  data: z.object({
    call: callSchema.passthrough(),
    recordings: z.array(callRecordingSchema.passthrough()),
  }),
})
const recordingEnvelope = z.object({ data: callRecordingSchema.passthrough() })

export type CallingRouteDeps = {
  service?: CallingService
}

/**
 * Providers this deployment exposes for calling. Only the built-in
 * console/dev provider today — real vendor adapters (Twilio/Exotel/Plivo/…)
 * land in `packages/integrations/src/providers/` later and get added here.
 *
 * BLOCKER (integrator): for click-to-call AND inbound status webhooks to
 * work through the standard integrations surface, the SAME provider(s)
 * returned here must also be added to `defaultIntegrationProviders()` in
 * `apps/api/src/routes/modules/integrations.ts` — that file's webhook
 * endpoint dispatches on its OWN provider list, not this one. That file is
 * outside this module's ownership (shared with the Email/WhatsApp agents
 * building alongside this one), so it is not edited here. Once
 * `@yourcrm/integrations`'s `getIntegrationProviderRegistry()` is wired in
 * there instead of a hardcoded array (already possible — both `@yourcrm/crm`
 * and `apps/api` declare the dependency today), both provider lists collapse
 * into one and this note goes away.
 */
function defaultService(): CallingService {
  const db = getDb()
  const repository = createCallingRepository()
  const integrations = createIntegrationsRepository()

  // The console provider's webhook handler needs to call back into this
  // service (`applyProviderStatusEvent`); the service needs the provider
  // catalogue to exist first. Bound once, immediately below.
  let serviceRef: CallingService | null = null

  const providers = createCallingProviderCatalog([
    createConsoleCallingProvider({
      onStatusEvent: async (evt) => {
        await serviceRef?.applyProviderStatusEvent({
          workspaceId: evt.workspaceId,
          providerId: evt.providerId,
          providerCallId: evt.providerCallId,
          status: evt.status,
          occurredAt: evt.occurredAt,
          durationSeconds: evt.durationSeconds,
          errorMessage: evt.errorMessage,
        })
      },
    }),
  ])

  const service = createCallingService({
    store: {
      list: (workspaceId, query) =>
        repository.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          direction: query.direction,
          status: query.status,
          personId: query.personId,
          companyId: query.companyId,
          dealId: query.dealId,
          ownerId: query.ownerId,
          query: query.query,
        }),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      findByProviderCallId: (workspaceId, providerId, providerCallId) =>
        repository.findByProviderCallId(db, workspaceId, providerId, providerCallId),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreateCallInput, actorId),
      update: (workspaceId, id, patch, actorId) =>
        repository.update(db, workspaceId, id, patch as unknown as UpdateCallInput, actorId),
      advanceStatus: (workspaceId, id, next) => repository.advanceStatus(db, workspaceId, id, next),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDelete(db, workspaceId, id, actorId)
      },
      restore: async (workspaceId, id) => {
        await repository.restore(db, workspaceId, id)
      },
    },
    recordings: {
      create: (workspaceId, input, actorId) =>
        repository.createRecording(db, workspaceId, input, actorId),
      listForCall: (workspaceId, callId) =>
        repository.listRecordingsForCall(db, workspaceId, callId),
    },
    connections: {
      findById: async (workspaceId, id) => {
        const row = await integrations.findConnectionById(db, workspaceId, id)
        return row
          ? {
              id: row.id,
              workspaceId: row.workspaceId,
              providerId: row.providerId,
              status: row.status,
              config: row.config,
            }
          : null
      },
      listConnected: async (workspaceId) => {
        const result = await integrations.listConnections(db, {
          workspaceId,
          status: "connected",
          limit: 200,
        })
        return result.data.map((row) => ({
          id: row.id,
          workspaceId: row.workspaceId,
          providerId: row.providerId,
          status: row.status,
          config: row.config,
        }))
      },
    },
    credentials: {
      readSecret: (workspaceId, connectionId) =>
        integrations.readCredentialSecret(db, workspaceId, connectionId, "api_key"),
    },
    providers,
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
    events: getEventBus(),
  })

  serviceRef = service
  return service
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

const STATUS_BY_CODE: Record<string, 400 | 403 | 404 | 409 | 502> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INVALID_PHONE_NUMBER: 400,
  NO_PROVIDER_CONNECTED: 409,
  AMBIGUOUS_CONNECTION: 409,
  CONNECTION_NOT_CONNECTED: 409,
  RECORDING_CONSENT_REQUIRED: 409,
  CALLING_PROVIDER_CALL_FAILED: 502,
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
  if (
    err instanceof CallNotFoundError ||
    err instanceof CallingConnectionNotFoundError ||
    err instanceof CallingProviderNotRegisteredError ||
    err instanceof NoCallingProviderConnectedError ||
    err instanceof AmbiguousCallingConnectionError ||
    err instanceof CallingConnectionNotConnectedError ||
    err instanceof RecordingConsentRequiredError ||
    err instanceof MissingCallerIdError ||
    err instanceof CallingProviderCallFailedError
  ) {
    const status = STATUS_BY_CODE[err.code] ?? 400
    return c.json(errorEnvelope(err.code, err.message, requestId), status)
  }
  if (err instanceof Error && (err as { code?: string }).code === "INVALID_PHONE_NUMBER") {
    return c.json(errorEnvelope("INVALID_PHONE_NUMBER", err.message, requestId), 400)
  }
  throw err
}

function invalidBody(c: Context, details: unknown, what = "Invalid request body") {
  return c.json(
    errorEnvelope("VALIDATION_ERROR", what, c.req.header("x-request-id") ?? undefined, details),
    400,
  )
}

export function createRoutes(deps: CallingRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  let cached: CallingService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/",
    requireSession(),
    zValidator("query", callQuerySchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten(), "Invalid query parameters")
    }),
    async (c) => {
      try {
        return c.json(await service().list(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  /** Manual log: a rep records a call made outside the system. No provider required. */
  app.post(
    "/log",
    requireSession(),
    zValidator("json", logCallSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten())
    }),
    async (c) => {
      try {
        const call = await service().logCall(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: call }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  /** Click-to-call: place the call through a connected provider. Requires `send_external`. */
  app.post(
    "/place",
    requireSession(),
    zValidator("json", placeCallSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten())
    }),
    async (c) => {
      try {
        const call = await service().placeCall(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: call }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/:id", requireSession(), async (c) => {
    try {
      const found = await service().get(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: found })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateCallSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten())
    }),
    async (c) => {
      try {
        const call = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: call })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/:id", requireSession(), async (c) => {
    try {
      await service().softDelete(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/:id/restore", requireSession(), async (c) => {
    try {
      const call = await service().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: call })
    } catch (err) {
      return mapError(c, err)
    }
  })

  /** Attach recording metadata (url/duration/size). Requires consent already on the call. */
  app.post(
    "/:id/recordings",
    requireSession(),
    zValidator("json", addCallRecordingSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result.error.flatten())
    }),
    async (c) => {
      try {
        const recording = await service().addRecording(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: recording }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  return app
}

export const openApiPaths = {
  "/api/v1/calling": {
    get: {
      summary:
        "List calls (cursor pagination, filters: direction, status, person/company/deal/owner)",
      operationId: "listCalls",
    },
  },
  "/api/v1/calling/log": {
    post: {
      summary: "Manually log a call made outside the system (no provider required)",
      operationId: "logCall",
      requestBody: { content: { "application/json": { schema: zodToJsonSchema(logCallSchema) } } },
    },
  },
  "/api/v1/calling/place": {
    post: {
      summary: "Click-to-call: place a call through a connected provider (send_external)",
      operationId: "placeCall",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(placeCallSchema) } },
      },
    },
  },
  "/api/v1/calling/{id}": {
    get: { summary: "Get a call with its recording metadata", operationId: "getCall" },
    patch: {
      summary: "Update a call's links/disposition/notes/consent",
      operationId: "updateCall",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateCallSchema) } },
      },
    },
    delete: { summary: "Soft-delete a call", operationId: "deleteCall" },
  },
  "/api/v1/calling/{id}/restore": {
    post: { summary: "Restore a soft-deleted call", operationId: "restoreCall" },
  },
  "/api/v1/calling/{id}/recordings": {
    post: {
      summary:
        "Attach recording metadata (url/duration/size) — requires recording consent on the call",
      operationId: "addCallRecording",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(addCallRecordingSchema) } },
      },
    },
  },
}

export { callDetailEnvelope, callEnvelope, callListEnvelope, recordingEnvelope }
