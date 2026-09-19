import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import { loadEnv } from "@yourcrm/config"
import { createOpenAiCompatibleAiProvider } from "@yourcrm/crm/src/ai-assistant"
import {
  createAiGovernanceService,
  type AiActionProposalPort,
} from "@yourcrm/crm/src/ai-governance"
import {
  callTranscriptSchema,
  conversationAnalysisQuerySchema,
  conversationAnalysisSchema,
  conversationIntelligenceStatusSchema,
  conversationSubjectTypeSchema,
  createCallTranscriptConversationSource,
  createConversationIntelligenceService,
  createConversationSource,
  createConversationSourceRegistry,
  conversationSubjectPermission,
  ingestCallTranscriptSchema,
  proposeConversationActionItemSchema,
  requestConversationAnalysisSchema,
  type ConversationAnalysisJob,
  type ConversationIntelligenceService,
  type ConversationSubjectReading,
  type ConversationTurn,
} from "@yourcrm/crm/src/conversation-intelligence"
import { emailDisplayText } from "@yourcrm/crm/src/email"
import { getDb, writeAudit } from "@yourcrm/database"
import {
  createAiGovernanceRepository,
  type CreateAiActionRequestInput,
  type CreateAiPolicyInput,
  type UpdateAiActionRequestInput,
  type UpdateAiPolicyInput,
} from "@yourcrm/database/src/repositories/ai-governance-repository"
import { createCallingRepository } from "@yourcrm/database/src/repositories/calling-repository"
import {
  createConversationIntelligenceRepository,
  type CreateConversationAnalysisInput,
  type UpsertCallTranscriptInput,
} from "@yourcrm/database/src/repositories/conversation-intelligence-repository"
import { createEmailRepository } from "@yourcrm/database/src/repositories/email-repository"
import { listMembershipsForUser } from "@yourcrm/database/src/schema/auth"
import { getEventBus } from "@yourcrm/events"
import { PermissionDeniedError, requirePermission } from "@yourcrm/permissions"
import { errorEnvelope, paginatedEnvelopeSchema, type ServiceContext } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * Conversation intelligence (spec 37, P0).
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. The guarantees
 * live in `@yourcrm/crm/src/conversation-intelligence` and are restated
 * there; this file is the COMPOSITION ROOT and its only interesting job
 * is deciding what the service is allowed to reach.
 *
 * ## What is wired, and why it is wired this way
 *
 * ```text
 * store      -> conversation-intelligence-repository (this module's own tables)
 * provider   -> the OpenAI-compatible provider, from validated env
 * sources    -> per-channel adapters over the owning modules (below)
 * governance -> spec 38's approval queue: the ONLY route from an action
 *               item to a task, and it only ever proposes
 * queue      -> the BullMQ seam (see the blocker note under defaultQueue)
 * ```
 *
 * ## The source adapters
 *
 * `email_thread` and `call` are bound here. WhatsApp is deliberately not:
 * its conversation shape (session windows, template messages) needs the
 * WhatsApp module's own judgement about what a "turn" is, and guessing
 * here would be a second, worse copy of it. An unbound subject type is
 * simply not analysable — `readableConversationSubjectTypes` excludes it,
 * so nothing degrades into "readable by default".
 *
 * Both adapters read through the owning module's REPOSITORY contract, not
 * its tables, and the OBJECT gate (`read` on `email_thread` / `call`) has
 * already run inside the domain service before an adapter is called — plus
 * each adapter re-checks it, so it is safe even if called directly. If
 * Email or Calling later grows record-level visibility (an owner-only
 * rule, a team scope), these two adapters must switch to
 * `EmailService.getThread` / `CallingService.get` so the new rule is
 * inherited automatically. That is the one thing to watch here, and it is
 * called out again above each adapter.
 */

export const basePath = "/conversation-intelligence"

const analysisEnvelope = z.object({ data: conversationAnalysisSchema.passthrough() })
const analysisListEnvelope = paginatedEnvelopeSchema(conversationAnalysisSchema.passthrough())
const analysisDetailEnvelope = z.object({
  data: z.object({
    analysis: conversationAnalysisSchema.passthrough(),
    subject: z
      .object({
        subjectType: z.string(),
        subjectId: z.string(),
        title: z.string(),
        participants: z.array(z.string()),
        occurredAt: z.string().nullable(),
        turns: z.array(
          z.object({ speaker: z.string(), at: z.string().nullable(), text: z.string() }),
        ),
        sourceChars: z.number(),
        analysedChars: z.number(),
        truncated: z.boolean(),
      })
      .nullable(),
  }),
})
const transcriptEnvelope = z.object({ data: callTranscriptSchema.passthrough() })
const statusEnvelope = z.object({ data: conversationIntelligenceStatusSchema })

export type ConversationIntelligenceRouteDeps = {
  service?: ConversationIntelligenceService
}

/** Raised by the composition root, mapped to 503 — never leaks the key. */
class ConversationIntelligenceNotConfiguredError extends Error {
  readonly code = "AI_PROVIDER_NOT_CONFIGURED"
  constructor() {
    super("the AI provider is not configured (set AI_API_KEY and AI_DEFAULT_MODEL)")
    this.name = "ConversationIntelligenceNotConfiguredError"
  }
}

/**
 * Queue binding.
 *
 * BLOCKER (a dependency change an agent may not make): `@yourcrm/api`
 * does not declare `bullmq`, so this cannot push to
 * `getQueue(QueueNames.Ai)` yet. Exactly the same gap
 * `routes/modules/automation.ts` documents for workflow runs. Until the
 * dependency is declared the enqueue is a structured log line and the row
 * stays `queued`; swapping in the real adapter is a two-line change here:
 *
 * ```ts
 * await getQueue(QueueNames.Ai).add(CONVERSATION_ANALYSIS_JOB_NAME, job, {
 *   jobId: `conversation_intelligence.analyze:${job.analysisId}`,
 * })
 * ```
 *
 * The log line carries ids only — no subject title, no conversation text.
 */
function defaultQueue() {
  return {
    enqueueConversationAnalysis: async (job: ConversationAnalysisJob): Promise<void> => {
      console.log(
        JSON.stringify({
          level: "info",
          msg: "conversation_analysis_enqueued",
          job: "conversation_intelligence.analyze",
          jobId: `conversation_intelligence.analyze:${job.analysisId}`,
          workspaceId: job.workspaceId,
          subjectType: job.subjectType,
          analysisType: job.analysisType,
          ...(job.correlationId === undefined || job.correlationId === null
            ? {}
            : { correlationId: job.correlationId }),
        }),
      )
    },
  }
}

/**
 * The `email_thread` source.
 *
 * Reads Email's own repository contract and flattens each message to
 * plain text with Email's own `emailDisplayText` (so HTML is sanitised by
 * the module that owns the format, not re-implemented here).
 *
 * WATCH THIS: Email currently applies no record-level visibility beyond
 * workspace scope, so the object gate — which runs in the domain service
 * and again below — is the whole rule. The day Email adds an owner or
 * team scope, this adapter must call `EmailService.getThread` instead.
 */
function emailThreadSource() {
  const db = getDb()
  const repository = createEmailRepository()

  const toTurn = (detail: {
    message: Record<string, unknown>
    participants: { role: string; address: string }[]
  }): ConversationTurn => {
    const from =
      typeof detail.message.fromAddress === "string" && detail.message.fromAddress !== ""
        ? detail.message.fromAddress
        : (detail.participants.find((p) => p.role === "from")?.address ?? "Unknown sender")
    const sentAt = detail.message.sentAt
    return {
      speaker: from,
      at: sentAt instanceof Date ? sentAt.toISOString() : null,
      text: emailDisplayText(
        typeof detail.message.bodyText === "string" ? detail.message.bodyText : null,
        typeof detail.message.bodyHtml === "string" ? detail.message.bodyHtml : null,
      ),
    }
  }

  return createConversationSource("email_thread", {
    read: async (ctx, subjectId): Promise<ConversationSubjectReading | null> => {
      // Defence in depth: the domain service already ran this gate.
      requirePermission(conversationSubjectPermission(ctx, "email_thread"))
      const found = await repository.findThreadWithMessages(db, ctx.workspaceId, subjectId)
      if (!found) return null
      const participants = [
        ...new Set(found.messages.flatMap((detail) => detail.participants.map((p) => p.address))),
      ]
      const first = found.messages[0]?.message
      return {
        title:
          typeof found.thread.subject === "string" && found.thread.subject !== ""
            ? found.thread.subject
            : "(no subject)",
        turns: found.messages.map(toTurn),
        participants,
        occurredAt:
          first?.sentAt instanceof Date
            ? first.sentAt.toISOString()
            : found.thread.createdAt instanceof Date
              ? found.thread.createdAt.toISOString()
              : null,
      }
    },
    filterReadable: async (ctx, subjectIds) => {
      requirePermission(conversationSubjectPermission(ctx, "email_thread"))
      const found = await Promise.all(
        subjectIds.map((id) => repository.findThreadById(db, ctx.workspaceId, id)),
      )
      return found.filter((thread) => thread !== null).map((thread) => String(thread.id))
    },
  })
}

/**
 * The `call` source: the CALL comes from Calling (which decides who may
 * read it), the TEXT comes from this module's own `call_transcripts`.
 *
 * Same watch note as above: when Calling grows record-level visibility,
 * swap the repository lookups for `CallingService.get`.
 */
function callSource(store: Parameters<typeof createCallTranscriptConversationSource>[0]["store"]) {
  const db = getDb()
  const repository = createCallingRepository()
  return createCallTranscriptConversationSource({
    store,
    calls: {
      read: async (ctx, subjectId): Promise<ConversationSubjectReading | null> => {
        // Defence in depth: the domain service already ran this gate.
        requirePermission(conversationSubjectPermission(ctx, "call"))
        const call = await repository.findById(db, ctx.workspaceId, subjectId)
        if (!call) return null
        const startedAt = call.startedAt
        return {
          title: `${call.direction === "inbound" ? "Inbound" : "Outbound"} call ${call.fromNumber} → ${call.toNumber}`,
          // A call with no transcript yet has no turns: readable, but not
          // analysable. The source merges the transcript over this.
          turns: [],
          participants: [call.fromNumber, call.toNumber]
            .filter((value): value is string => typeof value === "string" && value !== "")
            .map((value) => value),
          occurredAt: startedAt instanceof Date ? startedAt.toISOString() : null,
        }
      },
      filterReadable: async (ctx, subjectIds) => {
        requirePermission(conversationSubjectPermission(ctx, "call"))
        const found = await Promise.all(
          subjectIds.map((id) => repository.findById(db, ctx.workspaceId, id)),
        )
        return found.filter((call) => call !== null).map((call) => String(call.id))
      },
    },
  })
}

/**
 * Spec 38's approval queue, as a PROPOSAL port.
 *
 * Narrowed to `requestAction` on purpose: this module can propose and
 * nothing else. Approving, applying and reverting belong to
 * `routes/modules/ai-governance.ts` and to a human.
 *
 * KNOWN GAP to report, not to paper over: `ai-governance.ts`'s applier
 * registry binds `person` only, so approving a `task` proposal currently
 * fails there with `AI_ACTION_NOT_APPLICABLE`. Adding a `task` entry to
 * `AI_ACTION_APPLIERS` (one factory over the Tasks service) closes it.
 * Nothing here should work around that — a proposal that cannot be
 * applied must fail loudly at approval time, not be written directly.
 */
function defaultGovernance(): AiActionProposalPort {
  const db = getDb()
  const repository = createAiGovernanceRepository()
  const service = createAiGovernanceService({
    store: {
      listPolicies: (workspaceId, query) =>
        repository.searchPolicies(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          objectType: query.objectType,
          mode: query.mode,
        }),
      listActivePolicies: (workspaceId) => repository.listActivePolicies(db, workspaceId),
      findPolicyById: (workspaceId, id) => repository.findPolicyById(db, workspaceId, id),
      createPolicy: (workspaceId, input, actorId) =>
        repository.createPolicy(db, workspaceId, input as unknown as CreateAiPolicyInput, actorId),
      updatePolicy: (workspaceId, id, input, actorId) =>
        repository.updatePolicy(
          db,
          workspaceId,
          id,
          input as unknown as UpdateAiPolicyInput,
          actorId,
        ),
      softDeletePolicy: async (workspaceId, id, actorId) => {
        await repository.softDeletePolicy(db, workspaceId, id, actorId)
      },
      listRequests: (workspaceId, query) =>
        repository.searchRequests(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          status: query.status,
          objectType: query.objectType,
          recordId: query.recordId,
          runId: query.runId,
          actorId: query.actorId,
        }),
      findRequestById: (workspaceId, id) => repository.findRequestById(db, workspaceId, id),
      createRequest: (workspaceId, input, actorId) =>
        repository.createRequest(
          db,
          workspaceId,
          input as unknown as CreateAiActionRequestInput,
          actorId,
        ),
      updateRequest: (workspaceId, id, patch) =>
        repository.updateRequest(db, workspaceId, id, patch as UpdateAiActionRequestInput),
      recordDecision: (workspaceId, input) =>
        repository.recordDecision(db, workspaceId, {
          requestId: String(input.requestId),
          decision: String(input.decision),
          approverId: String(input.approverId),
          approverRole: (input.approverRole as string | null) ?? null,
          requesterRole: (input.requesterRole as string | null) ?? null,
          reason: (input.reason as string | null) ?? null,
          correlationId: (input.correlationId as string | null) ?? null,
        }),
      findApprovalByRequest: (workspaceId, requestId) =>
        repository.findApprovalByRequest(db, workspaceId, requestId),
      claimRequestApply: (workspaceId, id, claim) =>
        repository.claimRequestApply(db, workspaceId, id, claim),
      claimRequestRevert: (workspaceId, id, claim) =>
        repository.claimRequestRevert(db, workspaceId, id, claim),
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "ai" })
    },
    events: getEventBus(),
    // An analysis never applies anything, so the applier is unreachable
    // from this module: `requestAction` only calls it under an
    // `auto_apply` policy, which a workspace opts into deliberately.
    applier: {
      applyAiAction: () => {
        throw new ConversationIntelligenceApplyNotBoundError()
      },
      revertAiAction: () => {
        throw new ConversationIntelligenceApplyNotBoundError()
      },
    },
    resolveActorRole: async (workspaceId, actorId) => {
      const memberships = await listMembershipsForUser(db, actorId)
      const membership = memberships.find((m) => m.workspaceId === workspaceId)
      return membership ? (membership.role ?? "viewer") : null
    },
  })
  return { requestAction: (ctx, input) => service.requestAction(ctx, input) }
}

/**
 * Raised if a workspace sets an `auto_apply` policy for `task`: applying
 * belongs to `routes/modules/ai-governance.ts`, which owns the applier
 * registry. Failing here is correct — silently writing would not be.
 */
class ConversationIntelligenceApplyNotBoundError extends Error {
  readonly code = "AI_ACTION_NOT_APPLICABLE"
  constructor() {
    super(
      "applying an AI action is the approval queue's job — approve it in /ai/governance, where the appliers are bound",
    )
    this.name = "ConversationIntelligenceApplyNotBoundError"
  }
}

function defaultService(): ConversationIntelligenceService {
  const db = getDb()
  const env = loadEnv()
  const repository = createConversationIntelligenceRepository()

  if (!env.AI_API_KEY || !env.AI_DEFAULT_MODEL) {
    throw new ConversationIntelligenceNotConfiguredError()
  }

  const store = {
    listAnalyses: (
      workspaceId: string,
      query: {
        limit?: number
        cursor?: string
        order?: "asc" | "desc"
        subjectId?: string
        analysisType?: string
        status?: string
      },
      subjectTypes: readonly string[],
    ) =>
      repository.listAnalyses(db, {
        workspaceId,
        subjectTypes,
        limit: query.limit,
        cursor: query.cursor,
        order: query.order,
        subjectId: query.subjectId,
        analysisType: query.analysisType,
        status: query.status,
      }),
    findAnalysis: (workspaceId: string, id: string) => repository.findAnalysis(db, workspaceId, id),
    createAnalysis: (workspaceId: string, input: unknown, actorId?: string) =>
      repository.createAnalysis(db, workspaceId, input as CreateConversationAnalysisInput, actorId),
    updateAnalysis: (workspaceId: string, id: string, patch: unknown, actorId?: string) =>
      repository.updateAnalysis(db, workspaceId, id, patch as Record<string, never>, actorId),
    listTranscripts: (
      workspaceId: string,
      subjectType: string,
      subjectId: string,
      limit?: number,
    ) => repository.listTranscripts(db, workspaceId, subjectType, subjectId, limit),
    findTranscript: (workspaceId: string, id: string) =>
      repository.findTranscript(db, workspaceId, id),
    findTranscriptByExternalId: (workspaceId: string, externalId: string) =>
      repository.findTranscriptByExternalId(db, workspaceId, externalId),
    createTranscript: (workspaceId: string, input: unknown, actorId?: string) =>
      repository.createTranscript(db, workspaceId, input as UpsertCallTranscriptInput, actorId),
  } as unknown as Parameters<typeof createConversationIntelligenceService>[0]["store"]

  return createConversationIntelligenceService({
    store,
    sources: createConversationSourceRegistry([emailThreadSource(), callSource(store)]),
    provider: createOpenAiCompatibleAiProvider({
      baseUrl: env.AI_BASE_URL,
      apiKey: env.AI_API_KEY,
      model: env.AI_DEFAULT_MODEL,
      // Required: gateways reject unrecognised clients. See the provider.
      userAgent: env.AI_USER_AGENT,
      timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
    }),
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "ai" })
    },
    events: getEventBus(),
    governance: defaultGovernance(),
    queue: defaultQueue(),
  })
}

function serviceContextOf(c: Context<AppEnv>): ServiceContext {
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
  CONVERSATION_SOURCE_UNAVAILABLE: 503,
  CONVERSATION_QUEUE_UNAVAILABLE: 503,
  CONVERSATION_GOVERNANCE_UNAVAILABLE: 503,
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
  if (code === "CONVERSATION_SOURCE_EMPTY") {
    return c.json(errorEnvelope("VALIDATION_ERROR", (err as Error).message, requestId), 400)
  }
  if (code !== undefined && code in PROVIDER_STATUS) {
    // Provider messages are redacted of conversation content by the
    // domain service before they reach here.
    return c.json(
      errorEnvelope(code, (err as Error).message, requestId),
      PROVIDER_STATUS[code] ?? 502,
    )
  }
  if (code === "AI_ACTION_FORBIDDEN" || code === "AI_ACTION_NOT_APPLICABLE") {
    return c.json(errorEnvelope(code, (err as Error).message, requestId), 409)
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

const subjectParamsSchema = z.object({
  subjectType: conversationSubjectTypeSchema,
  subjectId: z.string().trim().min(1).max(128),
})

export function createRoutes(deps: ConversationIntelligenceRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database
  // or read credentials — registry and full-app tests mount every module.
  let cached: ConversationIntelligenceService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get("/status", requireSession(), (c) => {
    try {
      return c.json({ data: service().describeStatus(serviceContextOf(c)) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.get(
    "/analyses",
    requireSession(),
    zValidator("query", conversationAnalysisQuerySchema, (result, c) => {
      if (!result.success) return invalidBody(c, "Invalid query parameters", result.error.flatten())
    }),
    async (c) => {
      try {
        return c.json(await service().listAnalyses(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  /**
   * On-demand analysis: the user pressed the button and is waiting. One
   * provider call per requested type, each bounded — see `bounds.ts`.
   */
  app.post(
    "/analyses",
    requireSession(),
    zValidator("json", requestConversationAnalysisSchema, (result, c) => {
      if (!result.success) return invalidBody(c, "Invalid request body", result.error.flatten())
    }),
    async (c) => {
      try {
        const rows = await service().analyzeConversation(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: rows }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  /** Queued analysis: rows are persisted, the provider is not called here. */
  app.post(
    "/analyses/queue",
    requireSession(),
    zValidator("json", requestConversationAnalysisSchema, (result, c) => {
      if (!result.success) return invalidBody(c, "Invalid request body", result.error.flatten())
    }),
    async (c) => {
      try {
        const rows = await service().queueConversationAnalysis(
          serviceContextOf(c),
          c.req.valid("json"),
        )
        return c.json({ data: rows }, 202)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/analyses/:id", requireSession(), async (c) => {
    try {
      return c.json({ data: await service().getAnalysis(serviceContextOf(c), c.req.param("id")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  /** Extracted action items as DATA. Reading them creates nothing. */
  app.get("/analyses/:id/action-items", requireSession(), async (c) => {
    try {
      return c.json({
        data: await service().listActionItems(serviceContextOf(c), c.req.param("id")),
      })
    } catch (err) {
      return mapError(c, err)
    }
  })

  /**
   * Propose one action item as a task. Returns a PENDING approval request;
   * the task is created only when a human approves it in /ai/governance.
   */
  app.post(
    "/analyses/:id/action-items/propose",
    requireSession(),
    zValidator("json", proposeConversationActionItemSchema, (result, c) => {
      if (!result.success) return invalidBody(c, "Invalid request body", result.error.flatten())
    }),
    async (c) => {
      try {
        const outcome = await service().proposeConversationActionItem(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: outcome }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get(
    "/subjects/:subjectType/:subjectId/analyses",
    requireSession(),
    zValidator("param", subjectParamsSchema, (result, c) => {
      if (!result.success) return invalidBody(c, "Invalid subject", result.error.flatten())
    }),
    async (c) => {
      const params = c.req.valid("param")
      try {
        return c.json(
          await service().listAnalysesForSubject(
            serviceContextOf(c),
            params.subjectType,
            params.subjectId,
          ),
        )
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get(
    "/subjects/:subjectType/:subjectId/transcripts",
    requireSession(),
    zValidator("param", subjectParamsSchema, (result, c) => {
      if (!result.success) return invalidBody(c, "Invalid subject", result.error.flatten())
    }),
    async (c) => {
      const params = c.req.valid("param")
      try {
        return c.json({
          data: await service().listTranscripts(
            serviceContextOf(c),
            params.subjectType,
            params.subjectId,
          ),
        })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  /**
   * THE SPEECH-TO-TEXT SEAM. A transcript arrives as text — from a
   * notetaker/STT payload or a human paste. Idempotent on `externalId`,
   * so a re-delivered webhook returns 200 with the existing row.
   */
  app.post(
    "/transcripts",
    requireSession(),
    zValidator("json", ingestCallTranscriptSchema, (result, c) => {
      if (!result.success) return invalidBody(c, "Invalid request body", result.error.flatten())
    }),
    async (c) => {
      try {
        const { transcript, created } = await service().ingestCallTranscript(
          serviceContextOf(c),
          c.req.valid("json"),
        )
        return c.json({ data: transcript }, created ? 201 : 200)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  return app
}

export const openApiPaths = {
  "/api/v1/conversation-intelligence/status": {
    get: {
      summary:
        "Describe the configured analysis provider, the token cap and the analysable channels (no secrets)",
      operationId: "getConversationIntelligenceStatus",
    },
  },
  "/api/v1/conversation-intelligence/analyses": {
    get: {
      summary:
        "List conversation analyses the caller may read. Filtered by the visibility of the conversation each one describes",
      operationId: "listConversationAnalyses",
    },
    post: {
      summary:
        "Analyse a conversation now. Requires read on that conversation; the text is truncated to a documented cap before the model sees it",
      operationId: "analyzeConversation",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(requestConversationAnalysisSchema) },
        },
      },
    },
  },
  "/api/v1/conversation-intelligence/analyses/queue": {
    post: {
      summary: "Queue an analysis to run in the background. No provider call in this request",
      operationId: "queueConversationAnalysis",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(requestConversationAnalysisSchema) },
        },
      },
    },
  },
  "/api/v1/conversation-intelligence/analyses/{id}": {
    get: {
      summary: "Get one analysis with the source conversation it describes",
      operationId: "getConversationAnalysis",
    },
  },
  "/api/v1/conversation-intelligence/analyses/{id}/action-items": {
    get: {
      summary: "The action items this analysis extracted, as data. Creates nothing",
      operationId: "listConversationActionItems",
    },
  },
  "/api/v1/conversation-intelligence/analyses/{id}/action-items/propose": {
    post: {
      summary:
        "Propose one extracted action item as a task through the AI approval queue. Returns a pending request; nothing is created until a human approves it",
      operationId: "proposeConversationActionItem",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(proposeConversationActionItemSchema) },
        },
      },
    },
  },
  "/api/v1/conversation-intelligence/subjects/{subjectType}/{subjectId}/analyses": {
    get: {
      summary: "Every analysis of one conversation",
      operationId: "listConversationAnalysesForSubject",
    },
  },
  "/api/v1/conversation-intelligence/subjects/{subjectType}/{subjectId}/transcripts": {
    get: {
      summary: "Transcripts ingested for one conversation",
      operationId: "listCallTranscripts",
    },
  },
  "/api/v1/conversation-intelligence/transcripts": {
    post: {
      summary:
        "Ingest a transcript as text (notetaker/STT payload or manual paste). Idempotent on externalId. No audio processing happens here",
      operationId: "ingestCallTranscript",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(ingestCallTranscriptSchema) } },
      },
    },
  },
}

export {
  analysisDetailEnvelope,
  analysisEnvelope,
  analysisListEnvelope,
  statusEnvelope,
  transcriptEnvelope,
}
