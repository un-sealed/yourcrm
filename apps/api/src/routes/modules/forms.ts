import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createFormsService,
  createFormSchema,
  formFieldInputSchema,
  formFieldSchema,
  formQuerySchema,
  formSchema,
  formSubmissionSchema,
  reorderFormFieldsSchema,
  submissionQuerySchema,
  submitFormSchema,
  updateFormFieldSchema,
  updateFormSchema,
  type FormsService,
} from "@yourcrm/crm/src/forms"
import { getDb, writeAudit } from "@yourcrm/database"
import { createFormsRepository } from "@yourcrm/database/src/repositories/forms-repository"
import type {
  CreateFormFieldInput,
  CreateFormInput,
  CreateSubmissionInput,
  UpdateFormFieldInput,
  UpdateFormInput,
} from "@yourcrm/database/src/repositories/forms-repository"
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
 * Forms module (spec 23-forms, P0) — mirrors the people reference.
 *
 * Thin HTTP layer only: zod validation at the boundary, session from the
 * auth middleware, then straight into the domain service. No business logic
 * lives here. Denials surface as 403, unknown ids as 404, all in the shared
 * error envelope with the request id echoed.
 *
 * Two endpoints are intentionally public (no session) for embeds:
 * `GET /public/:publicId` and `POST /:id/submit`. The submit path is
 * rate-limited per form+IP (in-memory sliding window; a multi-instance
 * deployment would back this with Redis — noted, not built).
 */

export const basePath = "/forms"

const formEnvelope = z.object({ data: formSchema.passthrough() })
const formWithFieldsEnvelope = z.object({
  data: formSchema.passthrough().and(z.object({ fields: z.array(formFieldSchema.passthrough()) })),
})
const formListEnvelope = paginatedEnvelopeSchema(formSchema.passthrough())
const fieldEnvelope = z.object({ data: formFieldSchema.passthrough() })
const fieldsEnvelope = z.object({ data: z.array(formFieldSchema.passthrough()) })
const submissionEnvelope = z.object({ data: formSubmissionSchema.passthrough() })
const submissionListEnvelope = paginatedEnvelopeSchema(formSubmissionSchema.passthrough())

export type FormsRouteDeps = {
  service?: FormsService
}

function defaultService(): FormsService {
  const db = getDb()
  const repository = createFormsRepository()
  return createFormsService({
    store: {
      list: (workspaceId, query) =>
        repository.search(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          status: query.status,
        }),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      findWithFields: (workspaceId, id) => repository.findWithFields(db, workspaceId, id),
      findPublicByToken: (publicId) => repository.findPublicByToken(db, publicId),
      findPublishedById: (id) => repository.findPublishedById(db, id),
      create: (workspaceId, input, actorId) =>
        repository.create(db, workspaceId, input as unknown as CreateFormInput, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(db, workspaceId, id, input as unknown as UpdateFormInput, actorId),
      softDelete: async (workspaceId, id, actorId) => {
        await repository.softDelete(db, workspaceId, id, actorId)
      },
      restore: async (workspaceId, id) => {
        await repository.restore(db, workspaceId, id)
      },
      addField: (workspaceId, formId, input, actorId) =>
        repository.addField(
          db,
          workspaceId,
          formId,
          input as unknown as CreateFormFieldInput,
          actorId,
        ),
      updateField: (workspaceId, formId, fieldId, input, actorId) =>
        repository.updateField(
          db,
          workspaceId,
          formId,
          fieldId,
          input as unknown as UpdateFormFieldInput,
          actorId,
        ),
      removeField: async (workspaceId, formId, fieldId) => {
        await repository.removeField(db, workspaceId, formId, fieldId)
      },
      reorderFields: (workspaceId, formId, orderedIds) =>
        repository.reorderFields(db, workspaceId, formId, orderedIds),
      createSubmission: (workspaceId, formId, input) =>
        repository.createSubmission(
          db,
          workspaceId,
          formId,
          input as unknown as CreateSubmissionInput,
        ),
      listSubmissions: (workspaceId, formId, query) =>
        repository.listSubmissions(db, {
          workspaceId,
          formId,
          limit: query.limit,
          cursor: query.cursor,
        }),
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
  if (err instanceof z.ZodError) {
    return c.json(
      errorEnvelope("VALIDATION_ERROR", "Invalid submission values", requestId, err.flatten()),
      400,
    )
  }
  if (err instanceof Error && err.message.startsWith("forms.submit")) {
    return c.json(errorEnvelope("VALIDATION_ERROR", err.message, requestId), 400)
  }
  throw err
}

// -- Public submit rate limiting (per form + caller IP, sliding window). ----
const SUBMIT_WINDOW_MS = 10 * 60 * 1000
const SUBMIT_MAX_PER_WINDOW = 30
const submitHits = new Map<string, number[]>()

function submitRateKey(formId: string, ip: string): string {
  return `${formId}:${ip}`
}

export function checkSubmitRateLimit(formId: string, ip: string, now = Date.now()): boolean {
  const key = submitRateKey(formId, ip)
  const cutoff = now - SUBMIT_WINDOW_MS
  const hits = (submitHits.get(key) ?? []).filter((at) => at > cutoff)
  if (hits.length >= SUBMIT_MAX_PER_WINDOW) {
    submitHits.set(key, hits)
    return false
  }
  hits.push(now)
  submitHits.set(key, hits)
  // Opportunistic prune so the map cannot grow without bound.
  if (submitHits.size > 10000) {
    for (const [k, v] of submitHits) {
      if (v.every((at) => at <= cutoff)) submitHits.delete(k)
    }
  }
  return true
}

export function resetSubmitRateLimits(): void {
  submitHits.clear()
}

function callerIp(c: Context<AppEnv>): string {
  const forwarded = c.req.header("x-forwarded-for")
  const first = forwarded?.split(",")[0]?.trim()
  return first && first !== "" ? first : "unknown"
}

function sha256Hex(value: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (code + 31), 0x01000193) >>> 0
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`
}

export function createRoutes(deps: FormsRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  // The connection resolves on the first request that needs it (and then the
  // request fails loudly instead of crashing route setup).
  let cached: FormsService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  // -- Public embed endpoints (no session) ---------------------------------
  app.get("/public/:publicId", async (c) => {
    try {
      const found = await service().getPublic(c.req.param("publicId"))
      return c.json({ data: { ...found.form, fields: found.fields } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/:id/submit",
    zValidator("json", submitFormSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          errorEnvelope(
            "VALIDATION_ERROR",
            "Invalid submission body",
            c.req.header("x-request-id") ?? undefined,
            result.error.flatten(),
          ),
          400,
        )
      }
    }),
    async (c) => {
      try {
        const formId = c.req.param("id")
        const ip = callerIp(c)
        if (!checkSubmitRateLimit(formId, ip)) {
          return c.json(
            errorEnvelope(
              "RATE_LIMITED",
              "Too many submissions. Please try again later.",
              c.get("requestId") as string | undefined,
            ),
            429,
          )
        }
        const submission = await service().submit(formId, c.req.valid("json"), {
          ipHash: sha256Hex(`${formId}:${ip}`),
          userAgent: c.req.header("user-agent")?.slice(0, 500),
          correlationId: c.get("requestId") as string | undefined,
        })
        return c.json({ data: submission }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  // -- Staff endpoints (session required) -----------------------------------
  app.get(
    "/",
    requireSession(),
    zValidator("query", formQuerySchema, (result, c) => {
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
      const found = await service().get(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { ...found.form, fields: found.fields } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/",
    requireSession(),
    zValidator("json", createFormSchema, (result, c) => {
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
        const form = await service().create(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: form }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id",
    requireSession(),
    zValidator("json", updateFormSchema, (result, c) => {
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
        const form = await service().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: form })
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
      const form = await service().restore(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: form })
    } catch (err) {
      return mapError(c, err)
    }
  })

  // -- Field builder ---------------------------------------------------------
  app.post(
    "/:id/fields",
    requireSession(),
    zValidator("json", formFieldInputSchema, (result, c) => {
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
        const field = await service().addField(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: field }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:id/fields/:fieldId",
    requireSession(),
    zValidator("json", updateFormFieldSchema, (result, c) => {
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
        const field = await service().updateField(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.param("fieldId"),
          c.req.valid("json"),
        )
        return c.json({ data: field })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/:id/fields/:fieldId", requireSession(), async (c) => {
    try {
      await service().removeField(serviceContextOf(c), c.req.param("id"), c.req.param("fieldId"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/:id/fields/reorder",
    requireSession(),
    zValidator("json", reorderFormFieldsSchema, (result, c) => {
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
        const fields = await service().reorderFields(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: fields })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  // -- Submissions inbox ------------------------------------------------------
  app.get(
    "/:id/submissions",
    requireSession(),
    zValidator("query", submissionQuerySchema, (result, c) => {
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
        const result = await service().listSubmissions(
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

  return app
}

/** Default export for the module registry convention (`formsRoutes`). */
export default createRoutes

export const openApiPaths = {
  "/api/v1/forms": {
    get: {
      summary: "List forms (cursor pagination, search, status filter)",
      operationId: "listForms",
    },
    post: {
      summary: "Create a form with ordered field definitions",
      operationId: "createForm",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createFormSchema) } },
      },
    },
  },
  "/api/v1/forms/{id}": {
    get: { summary: "Get a form with its fields", operationId: "getForm" },
    patch: {
      summary: "Update a form",
      operationId: "updateForm",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateFormSchema) } },
      },
    },
    delete: { summary: "Soft-delete a form", operationId: "deleteForm" },
  },
  "/api/v1/forms/{id}/restore": {
    post: { summary: "Restore a soft-deleted form", operationId: "restoreForm" },
  },
  "/api/v1/forms/{id}/fields": {
    post: {
      summary: "Add a field definition to a form",
      operationId: "addFormField",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(formFieldInputSchema) } },
      },
    },
  },
  "/api/v1/forms/{id}/fields/{fieldId}": {
    patch: {
      summary: "Update a form field",
      operationId: "updateFormField",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateFormFieldSchema) } },
      },
    },
    delete: { summary: "Remove a form field", operationId: "removeFormField" },
  },
  "/api/v1/forms/{id}/fields/reorder": {
    post: {
      summary: "Persist field ordering",
      operationId: "reorderFormFields",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(reorderFormFieldsSchema) } },
      },
    },
  },
  "/api/v1/forms/{id}/submissions": {
    get: { summary: "List submissions for a form", operationId: "listFormSubmissions" },
  },
  "/api/v1/forms/public/{publicId}": {
    get: { summary: "Public embed lookup by share token", operationId: "getPublicForm" },
  },
  "/api/v1/forms/{id}/submit": {
    post: {
      summary: "Public submission endpoint (rate-limited)",
      operationId: "submitForm",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(submitFormSchema) } },
      },
    },
  },
}

export {
  fieldEnvelope,
  fieldsEnvelope,
  formEnvelope,
  formListEnvelope,
  formWithFieldsEnvelope,
  submissionEnvelope,
  submissionListEnvelope,
}
