import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createWorkflowAutomationService,
  createWorkflowSchema,
  describeWorkflowCatalogue,
  runWorkflowSchema,
  subscribeWorkflowDispatcher,
  updateWorkflowSchema,
  workflowQuerySchema,
  workflowRunQuerySchema,
  workflowRunSchema,
  workflowSchema,
  WORKFLOW_TARGET_UPDATED_EVENTS,
  type WorkflowActionExecutorPort,
  type WorkflowAutomationService,
  type WorkflowRunJobRequest,
} from "@yourcrm/crm/src/automation"
import { createTasksService } from "@yourcrm/crm/src/tasks"
import type { TasksService } from "@yourcrm/crm/src/tasks"
import { getDb, writeAudit } from "@yourcrm/database"
import {
  createAutomationRepository,
  describeWorkflowTargets,
  type CreateWorkflowInput,
  type UpdateWorkflowInput,
} from "@yourcrm/database/src/repositories/automation-repository"
import { createTasksRepository } from "@yourcrm/database/src/repositories/tasks-repository"
import type {
  CreateTaskInput,
  UpdateTaskInput,
} from "@yourcrm/database/src/repositories/tasks-repository"
import { listMembershipsForUser } from "@yourcrm/database/src/schema/auth"
import { createEvent, getEventBus } from "@yourcrm/events"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * Workflow automation module (spec 25-automation, P0).
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. The interesting
 * parts — idempotency, permission inheritance and loop protection — all
 * live in `@yourcrm/crm/src/automation`; this file only BINDS them:
 *
 *   store            -> automation repository (migration 0190)
 *   audit            -> writeAudit
 *   events           -> the in-process event bus
 *   resolveActorRole -> the memberships table (the owner's LIVE role)
 *   queue            -> the workflow-run queue seam
 *   executor         -> the owning modules' own service/repository
 *                       contracts, so no business rule is duplicated here
 *
 * INTEGRATION NOTES (both are dependency blockers an agent may not fix,
 * because they require editing `package.json`):
 *
 *  1. `@yourcrm/worker` cannot import `@yourcrm/crm`/`@yourcrm/database`,
 *     and `@yourcrm/api` cannot import `bullmq` or `@yourcrm/workflows`.
 *     Until those deps are declared, `defaultQueue()` records the enqueue
 *     as a structured log line instead of pushing to BullMQ, and runs stay
 *     `queued`. Swapping in the real adapter is a four-line change in one
 *     function — nothing else moves.
 *  2. The dispatcher subscription belongs in the app bootstrap
 *     (`apps/api/src/index.ts`), not in this factory: route construction
 *     happens in tests that emit unrelated events on the shared bus.
 *     `subscribeAutomationDispatcher()` below is the one-line call.
 */

export const basePath = "/automation"

const workflowEnvelope = z.object({ data: workflowSchema.passthrough() })
const workflowListEnvelope = paginatedEnvelopeSchema(workflowSchema.passthrough())
const workflowRunListEnvelope = paginatedEnvelopeSchema(workflowRunSchema.passthrough())

export type AutomationRouteDeps = {
  service?: WorkflowAutomationService
}

/**
 * Queue binding. The domain service only knows `WorkflowRunQueuePort`; the
 * canonical job name, payload schema and deterministic job id live in
 * `@yourcrm/workflows` (`workflowRunJobPayloadSchema`, `workflowRunJobId`).
 *
 * Replace the body with, once `bullmq` + `@yourcrm/workflows` are declared
 * dependencies of `@yourcrm/api`:
 *
 * ```ts
 * await getQueue(QueueNames.Automation).add(WORKFLOW_RUN_JOB_NAME, request, {
 *   jobId: workflowRunJobId(request),
 * })
 * ```
 */
function defaultQueue() {
  return {
    enqueueWorkflowRun: async (request: WorkflowRunJobRequest): Promise<void> => {
      console.log(
        JSON.stringify({
          level: "info",
          msg: "workflow_run_enqueued",
          job: "automation.run",
          jobId: `automation.run:${request.workspaceId}:${request.workflowId}:${request.triggerEventId}`,
          runId: request.runId,
          depth: request.depth,
          ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
        }),
      )
    },
  }
}

function defaultTasksService(): TasksService {
  const db = getDb()
  const repository = createTasksRepository()
  return createTasksService({
    store: {
      list: (workspaceId, query) => repository.search(db, { workspaceId, ...query }),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreateTaskInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(db, workspaceId, id, input as unknown as UpdateTaskInput, actorId),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDelete(db, workspaceId, id, actorId)
      },
      restore: async (workspaceId, id) => {
        await repository.restore(db, workspaceId, id)
      },
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "automation" })
    },
    events: getEventBus(),
  })
}

/**
 * Action bindings. Every action reaches the owning module through that
 * module's own contract: `create_task` goes through the tasks DOMAIN
 * SERVICE (so it re-checks the owner's permission, validates and emits
 * `task.created` itself), and the record/tag/notification writes go
 * through the allowlisted repository helpers in
 * `automation-repository.ts`.
 *
 * Each write emits the owning module's event constant and an audit row
 * with `source: "automation"`, so an automated change is indistinguishable
 * from a hand edit downstream — except that it is attributable.
 */
function defaultExecutor(): WorkflowActionExecutorPort {
  const db = getDb()
  const repository = createAutomationRepository()
  const tasks = defaultTasksService()
  const bus = getEventBus()

  return {
    createTask: async (ctx, input) => {
      const task = await tasks.create(ctx, {
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? null,
        dueDate: input.dueDate ?? null,
        assigneeId: input.assigneeId ?? null,
        ...(input.target?.entityType === "person" ? { personId: input.target.entityId } : {}),
        ...(input.target?.entityType === "company" ? { companyId: input.target.entityId } : {}),
        ...(input.target?.entityType === "deal" ? { dealId: input.target.entityId } : {}),
      })
      return { taskId: String(task.id) }
    },

    updateRecordField: async (ctx, target, field, value) => {
      const updated = await repository.updateTargetField(
        db,
        ctx.workspaceId,
        target,
        field,
        value,
        ctx.actorId,
      )
      const eventName = WORKFLOW_TARGET_UPDATED_EVENTS[target.entityType]
      if (eventName !== undefined) {
        await bus.emit(
          createEvent({
            event: eventName,
            workspaceId: ctx.workspaceId,
            actorId: ctx.actorId,
            actorType: "automation",
            entityType: target.entityType,
            entityId: target.entityId,
            after: { [field]: value },
            // Carries the cascade chain — see loop protection.
            ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
          }),
        )
      }
      await writeAudit(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        action: "update",
        object: target.entityType,
        recordId: updated.recordId,
        after: { [field]: value },
        correlationId: ctx.correlationId ?? null,
        source: "automation",
      })
      return updated
    },

    addTag: async (ctx, target, tag) => {
      const result = await repository.attachTagByName(db, ctx.workspaceId, target, tag, ctx.actorId)
      await writeAudit(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        action: "tag",
        object: target.entityType,
        recordId: target.entityId,
        after: { tag },
        correlationId: ctx.correlationId ?? null,
        source: "automation",
      })
      return result
    },

    notify: async (ctx, input) => {
      const result = await repository.createNotification(db, ctx.workspaceId, input, ctx.actorId)
      return result
    },
  }
}

function defaultService(): WorkflowAutomationService {
  const db = getDb()
  const repository = createAutomationRepository()
  return createWorkflowAutomationService({
    store: {
      list: (workspaceId, query) =>
        repository.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          status: query.status,
          triggerEvent: query.triggerEvent,
        }),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreateWorkflowInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(db, workspaceId, id, input as unknown as UpdateWorkflowInput, actorId),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDelete(db, workspaceId, id, actorId)
      },
      restore: async (workspaceId, id) => {
        await repository.restore(db, workspaceId, id)
      },
      listEnabledByTrigger: (workspaceId, triggerEvent) =>
        repository.listEnabledByTrigger(db, workspaceId, triggerEvent),
      markWorkflowRan: async (workspaceId, id) => {
        await repository.markWorkflowRan(db, workspaceId, id)
      },
      createRun: (workspaceId, input) =>
        repository.createRun(db, workspaceId, {
          workflowId: String(input.workflowId),
          triggerEventId: String(input.triggerEventId),
          triggerEvent: String(input.triggerEvent),
          entityType: (input.entityType as string | null) ?? null,
          entityId: (input.entityId as string | null) ?? null,
          triggerPayload: input.triggerPayload,
          status: (input.status as string | null) ?? null,
          depth: Number(input.depth ?? 0),
          parentRunId: (input.parentRunId as string | null) ?? null,
          actorId: (input.actorId as string | null) ?? null,
          correlationId: (input.correlationId as string | null) ?? null,
          error: (input.error as string | null) ?? null,
        }),
      findRunById: (workspaceId, id) => repository.findRunById(db, workspaceId, id),
      listRuns: (workspaceId, query) =>
        repository.searchRuns(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          workflowId: query.workflowId,
          status: query.status,
        }),
      updateRun: (workspaceId, id, patch) => repository.updateRun(db, workspaceId, id, patch),
      claimRunStep: (workspaceId, input) => repository.claimRunStep(db, workspaceId, input),
      completeRunStep: (workspaceId, id, patch) =>
        repository.completeRunStep(db, workspaceId, id, patch),
      listRunSteps: (workspaceId, runId) => repository.listRunSteps(db, workspaceId, runId),
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
    events: getEventBus(),
    queue: defaultQueue(),
    executor: defaultExecutor(),
    // PERMISSION INHERITANCE: the owner's role is read from memberships at
    // run time, so a demotion or removal takes effect on the next run.
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
  if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND") {
    return c.json(errorEnvelope("NOT_FOUND", err.message, requestId), 404)
  }
  // A definition that names an unknown object, field or action type never
  // reaches SQL — the repository rejects it. Surface it as a 400.
  if (err instanceof Error && (err as { code?: string }).code === "INVALID_WORKFLOW") {
    return c.json(errorEnvelope("VALIDATION_ERROR", err.message, requestId), 400)
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

export function createRoutes(deps: AutomationRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  let cached: WorkflowAutomationService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  // Static segments first: `/catalogue` and `/runs` must not be swallowed
  // by `/:id`.
  app.get("/catalogue", requireSession(), (c) =>
    c.json({ data: { ...describeWorkflowCatalogue(), targets: describeWorkflowTargets() } }),
  )

  app.get(
    "/runs",
    requireSession(),
    zValidator("query", workflowRunQuerySchema, (result, c) => {
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
      const detail = await service().getRun(serviceContextOf(c), c.req.param("runId"))
      return c.json({ data: { ...detail.run, steps: detail.steps } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.get(
    "/",
    requireSession(),
    zValidator("query", workflowQuerySchema, (result, c) => {
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
    zValidator("json", createWorkflowSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const workflow = await service().create(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: workflow }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/:id", requireSession(), async (c) => {
    try {
      return c.json({ data: await service().get(serviceContextOf(c), c.req.param("id")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateWorkflowSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const workflow = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: workflow })
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
      return c.json({ data: await service().restore(serviceContextOf(c), c.req.param("id")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  // Enabling an automation is the privileged act (`run_automation`);
  // disabling one only needs `update`. See the service for why.
  app.post("/:id/enable", requireSession(), async (c) => {
    try {
      const workflow = await service().setEnabled(serviceContextOf(c), c.req.param("id"), true)
      return c.json({ data: workflow })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/:id/disable", requireSession(), async (c) => {
    try {
      const workflow = await service().setEnabled(serviceContextOf(c), c.req.param("id"), false)
      return c.json({ data: workflow })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/:id/run",
    requireSession(),
    zValidator("json", runWorkflowSchema, (result, c) => {
      if (!result.success) return invalidBody(c, result)
    }),
    async (c) => {
      try {
        const result = await service().runNow(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: result }, 202)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/:id/runs", requireSession(), async (c) => {
    try {
      const result = await service().listRuns(serviceContextOf(c), {
        workflowId: c.req.param("id"),
      })
      return c.json(result)
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

/**
 * Bootstrap hook: connect the in-process event bus to the dispatcher so
 * domain events actually fire workflows. Call it ONCE from
 * `apps/api/src/index.ts`; route factories must not subscribe (see the
 * file header).
 */
export function subscribeAutomationDispatcher(
  service: WorkflowAutomationService = defaultService(),
): () => void {
  return subscribeWorkflowDispatcher(getEventBus(), service, (err) => {
    console.error(
      JSON.stringify({ level: "error", msg: "automation_dispatch_failed", err: String(err) }),
    )
  })
}

export const openApiPaths = {
  "/api/v1/automation": {
    get: {
      summary: "List workflows (search, status and trigger filters)",
      operationId: "listWorkflows",
    },
    post: {
      summary: "Create a workflow (always created disabled)",
      operationId: "createWorkflow",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createWorkflowSchema) } },
      },
    },
  },
  "/api/v1/automation/catalogue": {
    get: {
      summary: "Triggerable events, action types and updatable target fields",
      operationId: "getWorkflowCatalogue",
    },
  },
  "/api/v1/automation/runs": {
    get: { summary: "Workspace-wide run history", operationId: "listWorkflowRuns" },
  },
  "/api/v1/automation/runs/{runId}": {
    get: { summary: "One run with its per-step results", operationId: "getWorkflowRun" },
  },
  "/api/v1/automation/{id}": {
    get: { summary: "Get a workflow", operationId: "getWorkflow" },
    patch: {
      summary: "Update a workflow",
      operationId: "updateWorkflow",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateWorkflowSchema) } },
      },
    },
    delete: { summary: "Soft-delete a workflow", operationId: "deleteWorkflow" },
  },
  "/api/v1/automation/{id}/restore": {
    post: { summary: "Restore a soft-deleted workflow", operationId: "restoreWorkflow" },
  },
  "/api/v1/automation/{id}/enable": {
    post: {
      summary: "Enable a workflow (requires run_automation)",
      operationId: "enableWorkflow",
    },
  },
  "/api/v1/automation/{id}/disable": {
    post: { summary: "Disable a workflow", operationId: "disableWorkflow" },
  },
  "/api/v1/automation/{id}/run": {
    post: {
      summary: "Queue a manual test run with a sample payload",
      operationId: "runWorkflow",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(runWorkflowSchema) } },
      },
    },
  },
  "/api/v1/automation/{id}/runs": {
    get: { summary: "Run history for one workflow", operationId: "listRunsForWorkflow" },
  },
}

export { workflowEnvelope, workflowListEnvelope, workflowRunListEnvelope }
