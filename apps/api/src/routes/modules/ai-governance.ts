import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createAiGovernanceService,
  describeAiPolicyModes,
  AiSelfApprovalError,
  AI_ACTION_REQUEST_STATUSES,
  AI_ACTION_TYPES,
  AI_POLICY_MODES,
  aiActionRequestQuerySchema,
  aiActionRequestSchema,
  aiPolicyQuerySchema,
  aiPolicySchema,
  approveAiActionSchema,
  createAiActionRequestSchema,
  createAiPolicySchema,
  rejectAiActionSchema,
  revertAiActionSchema,
  updateAiPolicySchema,
  type AiActionApplierPort,
  type AiGovernanceService,
} from "@yourcrm/crm/src/ai-governance"
import { createPeopleService } from "@yourcrm/crm/src/people"
import type { PeopleService } from "@yourcrm/crm/src/people"
import { getDb, writeAudit } from "@yourcrm/database"
import {
  createAiGovernanceRepository,
  type CreateAiActionRequestInput,
  type CreateAiPolicyInput,
  type UpdateAiActionRequestInput,
  type UpdateAiPolicyInput,
} from "@yourcrm/database/src/repositories/ai-governance-repository"
import { createPeopleRepository } from "@yourcrm/database/src/repositories/people-repository"
import type {
  CreatePersonInput,
  UpdatePersonInput,
} from "@yourcrm/database/src/repositories/people-repository"
import { listMembershipsForUser } from "@yourcrm/database/src/schema/auth"
import { getEventBus } from "@yourcrm/events"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import type { ServiceContext } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * AI governance & approval queue (spec 38-ai-governance, P0).
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. The properties
 * that matter — no privilege escalation, no self-approval, exactly-once
 * apply, full attribution, no bypass — all live in
 * `@yourcrm/crm/src/ai-governance`; this file only BINDS them:
 *
 *   store            -> the AI governance repository (migration 0350)
 *   audit            -> writeAudit, `source: "ai"`
 *   events           -> the in-process event bus
 *   resolveActorRole -> the memberships table (the LIVE role, for both the
 *                       requesting actor and the approver)
 *   applier          -> the owning modules' own DOMAIN SERVICES
 *
 * INTEGRATION NOTES
 * -----------------
 *  1. MOUNTING. This module is not in the generated
 *     `routes/modules/index.ts` until the integrator runs
 *     `bun run gen:routes`. Until then the routes exist but are not
 *     served, and the web page at `/app/ai/governance` will show its
 *     error state.
 *  2. THE APPLIER REGISTRY. `AI_ACTION_APPLIERS` below binds ONE object
 *     type (`person`, the reference module) as a worked example. Adding a
 *     module is one entry — and it must be that module's DOMAIN SERVICE,
 *     never its repository and never SQL, so the module's own validation,
 *     events, audit row and `requirePermission()` all run. An object type
 *     with no binding is refused, which is the safe direction: governance
 *     can gate a module before it can apply for it.
 *  3. NAV. `/app/ai` already exists as a nav entry; the queue lives under
 *     it at `/app/ai/governance`.
 */

export const basePath = "/ai/governance"

const aiActionRequestEnvelope = z.object({ data: aiActionRequestSchema.passthrough() })
const aiActionRequestListEnvelope = paginatedEnvelopeSchema(aiActionRequestSchema.passthrough())
const aiPolicyListEnvelope = paginatedEnvelopeSchema(aiPolicySchema.passthrough())

export type AiGovernanceRouteDeps = {
  service?: AiGovernanceService
}

/* ------------------------------- the applier ------------------------------ */

/**
 * One object type's binding to its owning module.
 *
 * Every method takes the INHERITED service context (the requesting
 * actor's identity and live role) and calls the module's own service, so
 * the change is indistinguishable from a hand edit — except that it is
 * attributable.
 */
type AiObjectApplier = {
  create(ctx: ServiceContext, after: unknown): Promise<{ recordId: string }>
  update(ctx: ServiceContext, recordId: string, patch: unknown): Promise<{ recordId: string }>
  remove(ctx: ServiceContext, recordId: string): Promise<{ recordId: string }>
  restore(ctx: ServiceContext, recordId: string): Promise<{ recordId: string }>
}

class AiActionNotApplicableError extends Error {
  readonly code = "AI_ACTION_NOT_APPLICABLE"
  constructor(message: string) {
    super(message)
    this.name = "AiActionNotApplicableError"
  }
}

function defaultPeopleService(): PeopleService {
  const db = getDb()
  const repository = createPeopleRepository()
  return createPeopleService({
    store: {
      list: (workspaceId, query) => repository.search(db, { workspaceId, ...query }),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      findWithContacts: (workspaceId, id) => repository.findWithContacts(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreatePersonInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(db, workspaceId, id, input as unknown as UpdatePersonInput, actorId),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDelete(db, workspaceId, id, actorId)
      },
      restore: async (workspaceId, id) => {
        await repository.restore(db, workspaceId, id)
      },
    },
    // An AI-applied change is audited as `source: "ai"` by the owning
    // module too, so one record's history shows who really changed it.
    audit: async (input) => {
      await writeAudit(db, { ...input, source: "ai" })
    },
    events: getEventBus(),
  })
}

/**
 * THE REGISTRY. Add an object type here to let AI act on it.
 *
 * EXTENSION POINT: `company`, `deal`, `lead`, `task` and the custom-object
 * engine all follow the same four-line shape. They are deliberately not
 * bound yet — a binding is a decision to let AI write that object, and
 * that decision belongs to the integrator, not to this module.
 */
const AI_ACTION_APPLIERS: Record<string, () => AiObjectApplier> = {
  person: () => {
    const people = defaultPeopleService()
    return {
      create: async (ctx, after) => {
        const person = await people.create(ctx, after)
        return { recordId: String(person.id) }
      },
      update: async (ctx, recordId, patch) => {
        const person = await people.update(ctx, recordId, patch)
        return { recordId: String(person.id) }
      },
      remove: async (ctx, recordId) => {
        const person = await people.softDelete(ctx, recordId)
        return { recordId: String(person.id) }
      },
      restore: async (ctx, recordId) => {
        const person = await people.restore(ctx, recordId)
        return { recordId: String(person.id) }
      },
    }
  },
}

function applierFor(objectType: string): AiObjectApplier {
  const factory = AI_ACTION_APPLIERS[objectType]
  if (!factory) {
    throw new AiActionNotApplicableError(
      `AI cannot apply changes to '${objectType}' yet (bound object types: ${Object.keys(AI_ACTION_APPLIERS).join(", ")})`,
    )
  }
  return factory()
}

function requireRecordId(recordId: string | null, action: string): string {
  if (recordId === null || recordId === "") {
    throw new AiActionNotApplicableError(`a ${action} needs the record it targets`)
  }
  return recordId
}

/**
 * Applies and reverts through the owning module's domain service. This is
 * the ONLY place a governed change touches a record, and governance never
 * writes another module's tables.
 */
function defaultApplier(): AiActionApplierPort {
  return {
    applyAiAction: async (ctx, mutation) => {
      const applier = applierFor(mutation.objectType)
      switch (mutation.action) {
        case "create":
          return applier.create(ctx, mutation.after)
        case "update":
          return applier.update(ctx, requireRecordId(mutation.recordId, "update"), mutation.after)
        case "delete":
          return applier.remove(ctx, requireRecordId(mutation.recordId, "delete"))
        case "send_external":
          // No transport module is bound here yet, and inventing one would
          // be exactly the "second implementation" the rules forbid.
          throw new AiActionNotApplicableError(
            "sending externally is not bound to a transport module yet",
          )
      }
    },
    /** Restores the recorded `before` — the inverse of what was applied. */
    revertAiAction: async (ctx, mutation) => {
      const applier = applierFor(mutation.objectType)
      switch (mutation.action) {
        case "create":
          // Undoing a create is deleting what it created.
          return applier.remove(ctx, requireRecordId(mutation.appliedRecordId, "revert"))
        case "update":
          return applier.update(
            ctx,
            requireRecordId(mutation.appliedRecordId ?? mutation.recordId, "revert"),
            mutation.before,
          )
        case "delete":
          return applier.restore(ctx, requireRecordId(mutation.recordId, "revert"))
        case "send_external":
          throw new AiActionNotApplicableError("a sent message cannot be unsent")
      }
    },
  }
}

/* -------------------------------- the service ----------------------------- */

function defaultService(): AiGovernanceService {
  const db = getDb()
  const repository = createAiGovernanceRepository()
  return createAiGovernanceService({
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
    applier: defaultApplier(),
    // PERMISSION INHERITANCE: both the requesting actor's and the
    // approver's roles are read from memberships at decision time, so a
    // demotion or removal takes effect on everything still in the queue.
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
    // A session is a person. An `agent` context can only ever come from
    // in-process AI code calling the service directly — never over HTTP,
    // which is why no route can approve on an AI's behalf.
    actorType: "user" as const,
  }
}

function mapError(c: Context<AppEnv>, err: unknown) {
  const requestId = c.get("requestId") as string | undefined
  if (err instanceof PermissionDeniedError || err instanceof AiSelfApprovalError) {
    return c.json(errorEnvelope("FORBIDDEN", err.message, requestId), 403)
  }
  const code = err instanceof Error ? (err as { code?: string }).code : undefined
  if (code === "NOT_FOUND") {
    return c.json(errorEnvelope("NOT_FOUND", (err as Error).message, requestId), 404)
  }
  if (code === "CONFLICT") {
    return c.json(errorEnvelope("CONFLICT", (err as Error).message, requestId), 409)
  }
  if (code === "INVALID_AI_ACTION" || code === "AI_ACTION_NOT_APPLICABLE") {
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

export function createRoutes(deps: AiGovernanceRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  let cached: AiGovernanceService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  /** The server's own vocabulary, so the UI never hard-codes it. */
  app.get("/catalogue", requireSession(), (c) =>
    c.json({
      data: {
        actions: [...AI_ACTION_TYPES],
        statuses: [...AI_ACTION_REQUEST_STATUSES],
        modes: describeAiPolicyModes(),
        policyModes: [...AI_POLICY_MODES],
        appliableObjects: Object.keys(AI_ACTION_APPLIERS),
      },
    }),
  )

  /* -------------------------------- policies ------------------------------- */

  app.get(
    "/policies",
    requireSession(),
    zValidator("query", aiPolicyQuerySchema, (result, c) => {
      if (!result.success) return invalidQuery(c, result)
    }),
    async (c) => {
      try {
        return c.json(await service().listPolicies(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/policies",
    requireSession(),
    zValidator("json", createAiPolicySchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const policy = await service().createPolicy(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: policy }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/policies/:id", requireSession(), async (c) => {
    try {
      return c.json({ data: await service().getPolicy(serviceContextOf(c), c.req.param("id")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.patch(
    "/policies/:id",
    requireSession(),
    zValidator("json", updateAiPolicySchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const policy = await service().updatePolicy(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: policy })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/policies/:id", requireSession(), async (c) => {
    try {
      await service().deletePolicy(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  /* -------------------------------- the queue ------------------------------ */

  app.get(
    "/requests",
    requireSession(),
    zValidator("query", aiActionRequestQuerySchema, (result, c) => {
      if (!result.success) return invalidQuery(c, result)
    }),
    async (c) => {
      try {
        return c.json(await service().listRequests(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  /**
   * Propose an action. Over HTTP the proposer is always the signed-in
   * person using an AI feature; an autonomous agent calls the domain
   * service's `requestAction` in-process instead (`AiActionProposalPort`).
   */
  app.post(
    "/requests",
    requireSession(),
    zValidator("json", createAiActionRequestSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const outcome = await service().requestAction(serviceContextOf(c), c.req.valid("json"))
        return c.json(
          { data: { ...outcome.request, policyMode: outcome.mode, applied: outcome.applied } },
          201,
        )
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/requests/:id", requireSession(), async (c) => {
    try {
      const detail = await service().getRequest(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { ...detail.request, approval: detail.approval } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/requests/:id/approve",
    requireSession(),
    zValidator("json", approveAiActionSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const outcome = await service().approve(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: { ...outcome.request, applied: outcome.applied } })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/requests/:id/reject",
    requireSession(),
    zValidator("json", rejectAiActionSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const outcome = await service().reject(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: outcome.request })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  /** Retry path for an approved-but-unapplied request. Safe to repeat. */
  app.post("/requests/:id/apply", requireSession(), async (c) => {
    try {
      const outcome = await service().apply(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { ...outcome.request, applied: outcome.applied } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/requests/:id/revert",
    requireSession(),
    zValidator("json", revertAiActionSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const outcome = await service().revert(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: { ...outcome.request, reverted: outcome.reverted } })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  return app
}

export const openApiPaths = {
  "/api/v1/ai/governance/catalogue": {
    get: {
      summary: "AI action types, statuses, policy modes and bound objects",
      operationId: "getAiGovernanceCatalogue",
    },
  },
  "/api/v1/ai/governance/policies": {
    get: { summary: "List AI policies", operationId: "listAiPolicies" },
    post: {
      summary: "Create an AI policy (admin only)",
      operationId: "createAiPolicy",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createAiPolicySchema) } },
      },
    },
  },
  "/api/v1/ai/governance/policies/{id}": {
    get: { summary: "Get an AI policy", operationId: "getAiPolicy" },
    patch: {
      summary: "Update an AI policy (admin only)",
      operationId: "updateAiPolicy",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateAiPolicySchema) } },
      },
    },
    delete: { summary: "Delete an AI policy (admin only)", operationId: "deleteAiPolicy" },
  },
  "/api/v1/ai/governance/requests": {
    get: {
      summary: "The approval queue (filter by status, object, record, run or actor)",
      operationId: "listAiActionRequests",
    },
    post: {
      summary: "Propose an AI action — the only way an AI write can start",
      operationId: "createAiActionRequest",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createAiActionRequestSchema) } },
      },
    },
  },
  "/api/v1/ai/governance/requests/{id}": {
    get: {
      summary: "One proposed action with its diff and decision",
      operationId: "getAiActionRequest",
    },
  },
  "/api/v1/ai/governance/requests/{id}/approve": {
    post: {
      summary: "Approve and apply (never by the requester, never by an AI)",
      operationId: "approveAiActionRequest",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(approveAiActionSchema) } },
      },
    },
  },
  "/api/v1/ai/governance/requests/{id}/reject": {
    post: {
      summary: "Reject with a reason",
      operationId: "rejectAiActionRequest",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(rejectAiActionSchema) } },
      },
    },
  },
  "/api/v1/ai/governance/requests/{id}/apply": {
    post: {
      summary: "Apply an approved request (exactly-once; safe to retry)",
      operationId: "applyAiActionRequest",
    },
  },
  "/api/v1/ai/governance/requests/{id}/revert": {
    post: {
      summary: "Undo an applied AI action by restoring the recorded before-state",
      operationId: "revertAiActionRequest",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(revertAiActionSchema) } },
      },
    },
  },
}

export { aiActionRequestEnvelope, aiActionRequestListEnvelope, aiPolicyListEnvelope }
