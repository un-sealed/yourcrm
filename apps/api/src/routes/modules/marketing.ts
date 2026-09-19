import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createMarketingCampaignSchema,
  createMarketingCampaignsService,
  createMarketingConsentService,
  createMarketingSegmentSchema,
  createMarketingSegmentsService,
  marketingCampaignQuerySchema,
  marketingCampaignSchema,
  marketingSegmentQuerySchema,
  marketingSegmentSchema,
  scheduleMarketingCampaignSchema,
  unsubscribeByTokenSchema,
  updateMarketingCampaignSchema,
  updateMarketingSegmentSchema,
  upsertMarketingConsentSchema,
  type MarketingCampaignsService,
  type MarketingConsentService,
  type MarketingSegmentsService,
} from "@yourcrm/crm/src/marketing"
import { getDb, writeAudit } from "@yourcrm/database"
import {
  createMarketingCampaignsRepository,
  createMarketingConsentRepository,
  createMarketingRecipientsRepository,
  createMarketingSegmentsRepository,
} from "@yourcrm/database/src/repositories/marketing-repository"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * Marketing / Campaigns module (spec 24-marketing, P0).
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service
 * (`@yourcrm/crm/src/marketing`). No business logic here — consent
 * exclusion and claim-before-send idempotency live in the repository
 * (`@yourcrm/database/src/repositories/marketing-repository.ts`); this file
 * only binds it.
 *
 * SENDING / BULLMQ BLOCKER (same shape as `automation.ts`'s documented
 * one — not a new blocker, the same pre-existing gap): `@yourcrm/api` does
 * not declare `bullmq` as a dependency (see `apps/api/package.json`), and
 * agents may not edit `package.json`. `defaultQueue()` below therefore
 * records the enqueue as a structured log line instead of pushing to
 * BullMQ; campaigns stop at `sending` with zero recipients processed until
 * that dependency is added. Batch-to-batch continuation (after the first
 * batch) does NOT need this fix — `apps/worker` already declares `bullmq`
 * and self-enqueues the next batch directly (see
 * `apps/worker/src/jobs/campaigns.ts`). Swapping in the real adapter here
 * is a four-line change: `getQueue(QueueNames.Communications).add(...)`.
 *
 * EVENTS: no `MarketingEvents` group exists in `@yourcrm/events` yet (see
 * the domain service docs) — mutations are audited via `writeAudit` but do
 * not emit domain events.
 */

export const basePath = "/marketing"

const segmentEnvelope = z.object({ data: marketingSegmentSchema.passthrough() })
const segmentListEnvelope = paginatedEnvelopeSchema(marketingSegmentSchema.passthrough())
const campaignEnvelope = z.object({ data: marketingCampaignSchema.passthrough() })
const campaignListEnvelope = paginatedEnvelopeSchema(marketingCampaignSchema.passthrough())

export type MarketingRouteDeps = {
  segmentsService?: MarketingSegmentsService
  campaignsService?: MarketingCampaignsService
  consentService?: MarketingConsentService
}

/**
 * Queue binding — see the BLOCKER note above. Replace the body with, once
 * `bullmq` is declared:
 * ```ts
 * await getQueue(QueueNames.Communications).add("campaign.send_batch", request)
 * ```
 */
function defaultQueue() {
  return {
    enqueueCampaignBatch: async (request: {
      workspaceId: string
      campaignId: string
      batchSize: number
      correlationId?: string
    }): Promise<void> => {
      console.log(
        JSON.stringify({
          level: "info",
          msg: "campaign_batch_enqueued",
          job: "campaign.send_batch",
          workspaceId: request.workspaceId,
          campaignId: request.campaignId,
          batchSize: request.batchSize,
          ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
        }),
      )
    },
  }
}

function defaultSegmentsService(): MarketingSegmentsService {
  const db = getDb()
  const repository = createMarketingSegmentsRepository()
  return createMarketingSegmentsService({
    store: {
      list: (workspaceId, query) => repository.search(db, { workspaceId, ...query }),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.create(
          db,
          workspaceId,
          input as unknown as Parameters<typeof repository.create>[2],
          actorId,
        ),
      update: (workspaceId, id, input, actorId) =>
        repository.update(
          db,
          workspaceId,
          id,
          input as unknown as Parameters<typeof repository.update>[3],
          actorId,
        ),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDelete(db, workspaceId, id, actorId)
      },
      restore: async (workspaceId, id) => {
        await repository.restore(db, workspaceId, id)
      },
      evaluate: (workspaceId, filter) => repository.evaluate(db, workspaceId, filter),
      recordEvaluation: (workspaceId, id, memberCount) =>
        repository.recordEvaluation(db, workspaceId, id, memberCount),
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
  })
}

function defaultCampaignsService(): MarketingCampaignsService {
  const db = getDb()
  const campaignsRepo = createMarketingCampaignsRepository()
  const segmentsRepo = createMarketingSegmentsRepository()
  const recipientsRepo = createMarketingRecipientsRepository()
  return createMarketingCampaignsService({
    campaigns: {
      list: (workspaceId, query) => campaignsRepo.search(db, { workspaceId, ...query }),
      findById: (workspaceId, id) => campaignsRepo.findById(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        campaignsRepo.create(
          db,
          workspaceId,
          input as unknown as Parameters<typeof campaignsRepo.create>[2],
          actorId,
        ),
      update: (workspaceId, id, input, actorId) =>
        campaignsRepo.update(
          db,
          workspaceId,
          id,
          input as unknown as Parameters<typeof campaignsRepo.update>[3],
          actorId,
        ),
      softDelete: async (workspaceId, id, actorId) => {
        await campaignsRepo.softDelete(db, workspaceId, id, actorId)
      },
      setStatus: (workspaceId, id, status, extra) =>
        campaignsRepo.setStatus(db, workspaceId, id, status, extra),
      setCounters: (workspaceId, id, counters) =>
        campaignsRepo.setCounters(db, workspaceId, id, counters),
      incrementCounters: (workspaceId, id, delta) =>
        campaignsRepo.incrementCounters(db, workspaceId, id, delta),
    },
    segments: {
      list: (workspaceId, query) => segmentsRepo.search(db, { workspaceId, ...query }),
      findById: (workspaceId, id) => segmentsRepo.findById(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        segmentsRepo.create(
          db,
          workspaceId,
          input as unknown as Parameters<typeof segmentsRepo.create>[2],
          actorId,
        ),
      update: (workspaceId, id, input, actorId) =>
        segmentsRepo.update(
          db,
          workspaceId,
          id,
          input as unknown as Parameters<typeof segmentsRepo.update>[3],
          actorId,
        ),
      softDelete: async (workspaceId, id, actorId) => {
        await segmentsRepo.softDelete(db, workspaceId, id, actorId)
      },
      restore: async (workspaceId, id) => {
        await segmentsRepo.restore(db, workspaceId, id)
      },
      evaluate: (workspaceId, filter) => segmentsRepo.evaluate(db, workspaceId, filter),
      recordEvaluation: (workspaceId, id, memberCount) =>
        segmentsRepo.recordEvaluation(db, workspaceId, id, memberCount),
    },
    recipients: {
      prepareRecipients: (params) => recipientsRepo.prepareRecipients(db, params),
      claimBatch: (params) => recipientsRepo.claimBatch(db, params),
      markSent: (id, emailMessageId) => recipientsRepo.markSent(db, id, emailMessageId),
      markFailed: (id, reason) => recipientsRepo.markFailed(db, id, reason),
      countsByStatus: (workspaceId, campaignId) =>
        recipientsRepo.countsByStatus(db, workspaceId, campaignId),
    },
    queue: defaultQueue(),
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
  })
}

function defaultConsentService(): MarketingConsentService {
  const db = getDb()
  const repository = createMarketingConsentRepository()
  return createMarketingConsentService({
    store: {
      findByPersonId: (workspaceId, personId) =>
        repository.findByPersonId(db, workspaceId, personId),
      findByToken: (token) => repository.findByToken(db, token),
      upsert: (workspaceId, input, actorId) => repository.upsert(db, workspaceId, input, actorId),
      unsubscribeByToken: (token) => repository.unsubscribeByToken(db, token),
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
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

const STATUS_BY_CODE: Record<string, 400 | 403 | 404 | 409> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INVALID_SEGMENT_FILTER: 400,
  INVALID_STATE: 409,
}

function mapError(c: Context<AppEnv>, err: unknown) {
  const requestId = c.get("requestId") as string | undefined
  if (err instanceof PermissionDeniedError) {
    return c.json(errorEnvelope("FORBIDDEN", err.message, requestId), 403)
  }
  if (err instanceof Error) {
    const code = (err as { code?: string }).code
    const status = code ? STATUS_BY_CODE[code] : undefined
    if (code && status) {
      return c.json(errorEnvelope(code, err.message, requestId), status)
    }
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

export function createRoutes(deps: MarketingRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  let cachedSegments: MarketingSegmentsService | null = deps.segmentsService ?? null
  let cachedCampaigns: MarketingCampaignsService | null = deps.campaignsService ?? null
  let cachedConsent: MarketingConsentService | null = deps.consentService ?? null
  const segmentsService = () => (cachedSegments ??= defaultSegmentsService())
  const campaignsService = () => (cachedCampaigns ??= defaultCampaignsService())
  const consentService = () => (cachedConsent ??= defaultConsentService())

  /* ------------------------------- segments ------------------------------ */

  app.get(
    "/segments",
    requireSession(),
    zValidator("query", marketingSegmentQuerySchema, (result, c) => {
      if (!result.success) return invalidBody(c, "Invalid query parameters", result.error.flatten())
    }),
    async (c) => {
      try {
        const result = await segmentsService().list(serviceContextOf(c), c.req.valid("query"))
        return c.json(result)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/segments/:id", requireSession(), async (c) => {
    try {
      const segment = await segmentsService().get(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: segment })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/segments",
    requireSession(),
    zValidator("json", createMarketingSegmentSchema, (result, c) => {
      if (!result.success) return invalidBody(c, "Invalid request body", result.error.flatten())
    }),
    async (c) => {
      try {
        const segment = await segmentsService().create(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: segment }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/segments/:id",
    requireSession(),
    zValidator("json", updateMarketingSegmentSchema, (result, c) => {
      if (!result.success) return invalidBody(c, "Invalid request body", result.error.flatten())
    }),
    async (c) => {
      try {
        const segment = await segmentsService().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: segment })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/segments/:id", requireSession(), async (c) => {
    try {
      await segmentsService().softDelete(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/segments/:id/restore", requireSession(), async (c) => {
    try {
      const segment = await segmentsService().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: segment })
    } catch (err) {
      return mapError(c, err)
    }
  })

  /** Live audience count for the segment builder — evaluated on demand, never cached-only. */
  app.post("/segments/:id/preview", requireSession(), async (c) => {
    try {
      const result = await segmentsService().preview(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: result })
    } catch (err) {
      return mapError(c, err)
    }
  })

  /* ------------------------------- campaigns ------------------------------ */

  app.get(
    "/campaigns",
    requireSession(),
    zValidator("query", marketingCampaignQuerySchema, (result, c) => {
      if (!result.success) return invalidBody(c, "Invalid query parameters", result.error.flatten())
    }),
    async (c) => {
      try {
        const result = await campaignsService().list(serviceContextOf(c), c.req.valid("query"))
        return c.json(result)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/campaigns/:id", requireSession(), async (c) => {
    try {
      const campaign = await campaignsService().get(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: campaign })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/campaigns",
    requireSession(),
    zValidator("json", createMarketingCampaignSchema, (result, c) => {
      if (!result.success) return invalidBody(c, "Invalid request body", result.error.flatten())
    }),
    async (c) => {
      try {
        const campaign = await campaignsService().create(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: campaign }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/campaigns/:id",
    requireSession(),
    zValidator("json", updateMarketingCampaignSchema, (result, c) => {
      if (!result.success) return invalidBody(c, "Invalid request body", result.error.flatten())
    }),
    async (c) => {
      try {
        const campaign = await campaignsService().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: campaign })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/campaigns/:id", requireSession(), async (c) => {
    try {
      await campaignsService().softDelete(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/campaigns/:id/schedule",
    requireSession(),
    zValidator("json", scheduleMarketingCampaignSchema, (result, c) => {
      if (!result.success) return invalidBody(c, "Invalid request body", result.error.flatten())
    }),
    async (c) => {
      try {
        const campaign = await campaignsService().schedule(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: campaign })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  /** `send_external`-gated: materialises consent-filtered recipients and enqueues the first batch. */
  app.post("/campaigns/:id/send", requireSession(), async (c) => {
    try {
      const campaign = await campaignsService().send(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: campaign })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/campaigns/:id/cancel", requireSession(), async (c) => {
    try {
      const campaign = await campaignsService().cancel(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: campaign })
    } catch (err) {
      return mapError(c, err)
    }
  })

  /* -------------------------------- consent -------------------------------- */

  /** Record a person's marketing consent/opt-out. Normal workspace-role gate. */
  app.post(
    "/consents",
    requireSession(),
    zValidator("json", upsertMarketingConsentSchema, (result, c) => {
      if (!result.success) return invalidBody(c, "Invalid request body", result.error.flatten())
    }),
    async (c) => {
      try {
        const consent = await consentService().grant(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: consent })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  /**
   * Public unsubscribe link target. Deliberately NOT behind `requireSession()`
   * — the recipient clicking the link in an email has no session, only the
   * unguessable per-person token. See `consent-service.ts` for why this is
   * the one method in the module that does not call `requirePermission()`.
   */
  app.post(
    "/unsubscribe",
    zValidator("json", unsubscribeByTokenSchema, (result, c) => {
      if (!result.success) return invalidBody(c, "Invalid request body", result.error.flatten())
    }),
    async (c) => {
      try {
        const { token } = c.req.valid("json")
        const consent = await consentService().unsubscribeByToken(
          token,
          c.get("requestId") as string | undefined,
        )
        return c.json({ data: { unsubscribed: true, personId: consent.personId } })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  return app
}

export const openApiPaths = {
  "/api/v1/marketing/segments": {
    get: {
      summary: "List marketing segments (cursor pagination, search)",
      operationId: "listMarketingSegments",
    },
    post: {
      summary: "Create a marketing segment (a named filter over people)",
      operationId: "createMarketingSegment",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createMarketingSegmentSchema) } },
      },
    },
  },
  "/api/v1/marketing/segments/{id}": {
    get: { summary: "Get a marketing segment", operationId: "getMarketingSegment" },
    patch: {
      summary: "Update a marketing segment",
      operationId: "updateMarketingSegment",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateMarketingSegmentSchema) } },
      },
    },
    delete: { summary: "Soft-delete a marketing segment", operationId: "deleteMarketingSegment" },
  },
  "/api/v1/marketing/segments/{id}/preview": {
    post: {
      summary: "Live audience count for a segment's filter",
      operationId: "previewMarketingSegment",
    },
  },
  "/api/v1/marketing/campaigns": {
    get: {
      summary: "List campaigns (cursor pagination, search, status filter)",
      operationId: "listMarketingCampaigns",
    },
    post: {
      summary: "Create a draft campaign targeting a segment",
      operationId: "createMarketingCampaign",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createMarketingCampaignSchema) } },
      },
    },
  },
  "/api/v1/marketing/campaigns/{id}": {
    get: { summary: "Get a campaign", operationId: "getMarketingCampaign" },
    patch: {
      summary: "Update a draft campaign",
      operationId: "updateMarketingCampaign",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateMarketingCampaignSchema) } },
      },
    },
    delete: { summary: "Soft-delete a campaign", operationId: "deleteMarketingCampaign" },
  },
  "/api/v1/marketing/campaigns/{id}/send": {
    post: {
      summary: "Send a campaign (send_external): consent-filtered recipients, batched via BullMQ",
      operationId: "sendMarketingCampaign",
    },
  },
  "/api/v1/marketing/campaigns/{id}/cancel": {
    post: { summary: "Cancel a draft/scheduled campaign", operationId: "cancelMarketingCampaign" },
  },
  "/api/v1/marketing/unsubscribe": {
    post: {
      summary: "Public, token-authenticated unsubscribe (no session)",
      operationId: "unsubscribeMarketingConsent",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(unsubscribeByTokenSchema) } },
      },
    },
  },
}

export { campaignEnvelope, campaignListEnvelope, segmentEnvelope, segmentListEnvelope }
