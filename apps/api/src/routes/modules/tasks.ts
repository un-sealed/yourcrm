import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createTasksService,
  createTaskSchema,
  taskQuerySchema,
  taskSchema,
  updateTaskSchema,
  type TasksService,
} from "@yourcrm/crm/src/tasks"
import { getDb, writeAudit } from "@yourcrm/database"
import { createTasksRepository } from "@yourcrm/database/src/repositories/tasks-repository"
import type {
  CreateTaskInput,
  UpdateTaskInput,
} from "@yourcrm/database/src/repositories/tasks-repository"
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
 * Tasks module (spec 12-tasks, P0) — mirrors the people golden reference.
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. No business logic
 * lives here. Denials surface as 403, unknown ids as 404, all in the shared
 * error envelope with the request id echoed.
 */

export const basePath = "/tasks"

const taskEnvelope = z.object({ data: taskSchema.passthrough() })
const taskListEnvelope = paginatedEnvelopeSchema(taskSchema.passthrough())

export type TasksRouteDeps = {
  service?: TasksService
}

function defaultService(): TasksService {
  const db = getDb()
  const repository = createTasksRepository()
  return createTasksService({
    store: {
      list: (workspaceId, query) =>
        // `mine` is actor-scoped; the service already resolved it to an
        // assignee id before reaching this adapter.
        repository.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          status: query.status,
          priority: query.priority,
          assigneeId: query.assigneeId,
          overdue: query.overdue,
          dueBefore: query.dueBefore,
          dueAfter: query.dueAfter,
        }),
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

function mapError(c: Context<AppEnv>, err: unknown) {
  const requestId = c.get("requestId") as string | undefined
  if (err instanceof PermissionDeniedError) {
    return c.json(errorEnvelope("FORBIDDEN", err.message, requestId), 403)
  }
  if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND") {
    return c.json(errorEnvelope("NOT_FOUND", err.message, requestId), 404)
  }
  throw err
}

export function createRoutes(deps: TasksRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  // The connection resolves on the first request that needs it (and then the
  // request fails loudly instead of crashing route setup).
  let cached: TasksService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get(
    "/",
    requireSession(),
    zValidator("query", taskQuerySchema, (result, c) => {
      if (!result.success) {
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
    }),
    async (c) => {
      try {
        const result = await service().list(serviceContextOf(c), c.req.valid("query"))
        return c.json(result)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/:id", requireSession(), async (c) => {
    try {
      const task = await service().get(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: task })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/",
    requireSession(),
    zValidator("json", createTaskSchema, (result, c) => {
      if (!result.success) {
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
    }),
    async (c) => {
      try {
        const task = await service().create(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: task }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateTaskSchema, (result, c) => {
      if (!result.success) {
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
    }),
    async (c) => {
      try {
        const task = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: task })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post("/:id/complete", requireSession(), async (c) => {
    try {
      const task = await service().complete(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: task })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/:id/reopen", requireSession(), async (c) => {
    try {
      const task = await service().reopen(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: task })
    } catch (err) {
      return mapError(c, err)
    }
  })

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
      const task = await service().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: task })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/tasks": {
    get: {
      summary: "List tasks (cursor pagination, search, status/priority/assignee/overdue filters)",
      operationId: "listTasks",
    },
    post: {
      summary: "Create a task",
      operationId: "createTask",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createTaskSchema) } },
      },
    },
  },
  "/api/v1/tasks/{id}": {
    get: { summary: "Get a task", operationId: "getTask" },
    patch: {
      summary: "Update a task",
      operationId: "updateTask",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateTaskSchema) } },
      },
    },
    delete: { summary: "Soft-delete a task", operationId: "deleteTask" },
  },
  "/api/v1/tasks/{id}/complete": {
    post: { summary: "Mark a task completed", operationId: "completeTask" },
  },
  "/api/v1/tasks/{id}/reopen": {
    post: { summary: "Reopen a completed task", operationId: "reopenTask" },
  },
  "/api/v1/tasks/{id}/restore": {
    post: { summary: "Restore a soft-deleted task", operationId: "restoreTask" },
  },
}

export { taskEnvelope, taskListEnvelope }
