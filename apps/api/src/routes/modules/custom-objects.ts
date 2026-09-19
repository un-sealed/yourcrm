import { zValidator } from "@hono/zod-validator"
import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createCustomObjectFieldSchema,
  createCustomObjectRecordSchema,
  createCustomObjectSchema,
  createCustomObjectsService,
  customObjectFieldSchema,
  customObjectQuerySchema,
  customObjectRecordQuerySchema,
  customObjectRecordSchema,
  customObjectSchema,
  updateCustomObjectFieldSchema,
  updateCustomObjectRecordSchema,
  updateCustomObjectSchema,
  type CustomObjectFieldRecord,
  type CustomObjectsService,
} from "@yourcrm/crm/src/custom-objects"
import { getDb, writeAudit } from "@yourcrm/database"
import {
  createCustomFieldDefinitionsRepository,
  type CreateCustomFieldDefinitionInput,
  type UpdateCustomFieldDefinitionInput,
} from "@yourcrm/database/src/repositories/custom-fields-repository"
import {
  createCustomObjectsRepository,
  type CreateCustomObjectDefinitionInput,
  type CreateCustomObjectRecordInput,
  type UpdateCustomObjectDefinitionInput,
  type UpdateCustomObjectRecordInput,
} from "@yourcrm/database/src/repositories/custom-objects-repository"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * Custom objects & fields (spec 33-custom-objects-fields, P0).
 *
 * Thin HTTP layer over the metadata engine: zod at the boundary, session
 * from the auth middleware, then straight into the domain service. The
 * `:slug` path segment is user-authored, so the service validates it
 * against an allowlist and a reserved-word list before it is used for a
 * lookup — it never reaches SQL as anything but a bound parameter, and it
 * never reaches DDL at all (this module issues none).
 *
 * Field definitions are stored in the EXISTING `custom_field_definitions`
 * table via the existing repository, with `object_type` holding the custom
 * object's slug. There is no second field model.
 */

export const basePath = "/custom-objects"

const customObjectEnvelope = z.object({ data: customObjectSchema.passthrough() })
const customObjectListEnvelope = paginatedEnvelopeSchema(customObjectSchema.passthrough())
const customObjectRecordListEnvelope = paginatedEnvelopeSchema(
  customObjectRecordSchema.passthrough(),
)

export type CustomObjectsRouteDeps = {
  service?: CustomObjectsService
}

function defaultService(): CustomObjectsService {
  const db = getDb()
  const objectsRepo = createCustomObjectsRepository()
  // The wave-1 field catalog, reused as-is: custom objects add no second
  // field table and no parallel value model.
  const fieldsRepo = createCustomFieldDefinitionsRepository()

  return createCustomObjectsService({
    store: {
      listObjects: (workspaceId, query) =>
        objectsRepo.searchObjects(db, {
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
        }),
      findObjectById: (workspaceId, id) => objectsRepo.findObjectById(db, workspaceId, id),
      findObjectBySlug: (workspaceId, slug) => objectsRepo.findObjectBySlug(db, workspaceId, slug),
      createObject: (workspaceId, input, actorId) =>
        objectsRepo.createObject(
          db,
          workspaceId,
          input as unknown as CreateCustomObjectDefinitionInput,
          actorId,
        ),
      updateObject: (workspaceId, id, patch, actorId) =>
        objectsRepo.updateObject(
          db,
          workspaceId,
          id,
          patch as unknown as UpdateCustomObjectDefinitionInput,
          actorId,
        ),
      softDeleteObject: async (workspaceId, id, actorId) => {
        await objectsRepo.objects.softDelete(db, workspaceId, id, actorId)
      },
      restoreObject: async (workspaceId, id) => {
        await objectsRepo.objects.restore(db, workspaceId, id)
      },

      listFields: async (workspaceId, objectType) =>
        (await fieldsRepo.listByObject(db, workspaceId, objectType)) as CustomObjectFieldRecord[],
      findFieldById: async (workspaceId, id) =>
        (await fieldsRepo.findById(db, workspaceId, id)) as CustomObjectFieldRecord | null,
      createField: async (workspaceId, input, actorId) =>
        (await fieldsRepo.create(
          db,
          workspaceId,
          input as unknown as CreateCustomFieldDefinitionInput,
          actorId,
        )) as CustomObjectFieldRecord,
      updateField: async (workspaceId, id, patch, actorId) =>
        (await fieldsRepo.update(
          db,
          workspaceId,
          id,
          patch as unknown as UpdateCustomFieldDefinitionInput,
          actorId,
        )) as CustomObjectFieldRecord | null,
      softDeleteField: async (workspaceId, id, actorId) => {
        // SOFT: the definition is hidden, the values stay on disk.
        await fieldsRepo.softDelete(db, workspaceId, id, actorId)
      },

      listRecords: (workspaceId, objectId, query) =>
        objectsRepo.searchRecords(db, {
          workspaceId,
          objectId,
          limit: query.limit,
          cursor: query.cursor,
          order: query.order,
          query: query.query,
          match: query.match,
        }),
      findRecordById: (workspaceId, objectId, id) =>
        objectsRepo.findRecordById(db, workspaceId, objectId, id),
      createRecord: (workspaceId, input, actorId) =>
        objectsRepo.createRecord(
          db,
          workspaceId,
          input as unknown as CreateCustomObjectRecordInput,
          actorId,
        ),
      updateRecord: (workspaceId, objectId, id, patch, actorId) =>
        objectsRepo.updateRecord(
          db,
          workspaceId,
          objectId,
          id,
          patch as unknown as UpdateCustomObjectRecordInput,
          actorId,
        ),
      softDeleteRecord: async (workspaceId, id, actorId) => {
        await objectsRepo.records.softDelete(db, workspaceId, id, actorId)
      },
      restoreRecord: async (workspaceId, id) => {
        await objectsRepo.records.restore(db, workspaceId, id)
      },
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
    // No `events`: @yourcrm/events has no CustomObjectEvents group and this
    // module may neither add one nor emit a string literal. See the blocker
    // note on CustomObjectsServiceDeps.events.
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
  const code = err instanceof Error ? (err as { code?: string }).code : undefined
  if (code === "NOT_FOUND") {
    return c.json(errorEnvelope("NOT_FOUND", (err as Error).message, requestId), 404)
  }
  if (code === "CONFLICT") {
    return c.json(errorEnvelope("CONFLICT", (err as Error).message, requestId), 409)
  }
  // The runtime schema built from the field definitions rejects a payload,
  // a slug or a field key: a client error, not a server fault.
  if (code === "VALIDATION_ERROR") {
    const details = (err as { details?: unknown }).details
    return c.json(
      errorEnvelope("VALIDATION_ERROR", (err as Error).message, requestId, details),
      400,
    )
  }
  if (err instanceof z.ZodError) {
    return c.json(
      errorEnvelope("VALIDATION_ERROR", "Invalid request", requestId, err.flatten()),
      400,
    )
  }
  throw err
}

/**
 * Shared `zValidator` hook: every boundary failure becomes the same
 * `VALIDATION_ERROR` envelope with the request id echoed. Typed against the
 * bare Hono `Context` so one helper fits every route's inferred hook type.
 */
function invalidBody(message: string) {
  return (result: { success: boolean; error?: z.ZodError }, c: Context) => {
    if (!result.success) {
      return c.json(
        errorEnvelope(
          "VALIDATION_ERROR",
          message,
          c.req.header("x-request-id") ?? undefined,
          result.error?.flatten(),
        ),
        400,
      )
    }
    return undefined
  }
}

export function createRoutes(deps: CustomObjectsRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  let cached: CustomObjectsService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  // ---- object definitions -------------------------------------------------

  app.get(
    "/",
    requireSession(),
    zValidator("query", customObjectQuerySchema, invalidBody("Invalid query parameters")),
    async (c) => {
      try {
        return c.json(await service().listObjects(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/",
    requireSession(),
    zValidator("json", createCustomObjectSchema, invalidBody("Invalid request body")),
    async (c) => {
      try {
        const object = await service().createObject(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: object }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post("/:id/restore", requireSession(), async (c) => {
    try {
      const object = await service().restoreObject(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: object })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.get("/:slug", requireSession(), async (c) => {
    try {
      const found = await service().getObject(serviceContextOf(c), c.req.param("slug"))
      return c.json({ data: { ...found.object, fields: found.fields } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.patch(
    "/:slug",
    requireSession(),
    zValidator("json", updateCustomObjectSchema, invalidBody("Invalid request body")),
    async (c) => {
      try {
        const object = await service().updateObject(
          serviceContextOf(c),
          c.req.param("slug"),
          c.req.valid("json"),
        )
        return c.json({ data: object })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/:slug", requireSession(), async (c) => {
    try {
      await service().deleteObject(serviceContextOf(c), c.req.param("slug"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  // ---- field definitions --------------------------------------------------

  app.get("/:slug/fields", requireSession(), async (c) => {
    try {
      const fields = await service().listFields(serviceContextOf(c), c.req.param("slug"))
      return c.json({ data: fields })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/:slug/fields",
    requireSession(),
    zValidator("json", createCustomObjectFieldSchema, invalidBody("Invalid request body")),
    async (c) => {
      try {
        const field = await service().createField(
          serviceContextOf(c),
          c.req.param("slug"),
          c.req.valid("json"),
        )
        return c.json({ data: field }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/:slug/fields/:fieldId",
    requireSession(),
    // `.strict()` here is the type-change guard: `fieldType` and `key` are
    // not in the schema, so patching either is a 400, never a silent no-op.
    zValidator("json", updateCustomObjectFieldSchema, invalidBody("Invalid request body")),
    async (c) => {
      try {
        const field = await service().updateField(
          serviceContextOf(c),
          c.req.param("slug"),
          c.req.param("fieldId"),
          c.req.valid("json"),
        )
        return c.json({ data: field })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/:slug/fields/:fieldId", requireSession(), async (c) => {
    try {
      await service().deleteField(serviceContextOf(c), c.req.param("slug"), c.req.param("fieldId"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  // ---- records ------------------------------------------------------------

  app.get(
    "/:slug/records",
    requireSession(),
    zValidator("query", customObjectRecordQuerySchema, invalidBody("Invalid query parameters")),
    async (c) => {
      try {
        const result = await service().listRecords(
          serviceContextOf(c),
          c.req.param("slug"),
          c.req.valid("query"),
        )
        return c.json(result)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/:slug/records",
    requireSession(),
    zValidator("json", createCustomObjectRecordSchema, invalidBody("Invalid request body")),
    async (c) => {
      try {
        const record = await service().createRecord(
          serviceContextOf(c),
          c.req.param("slug"),
          c.req.valid("json"),
        )
        return c.json({ data: record }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post("/:slug/records/:id/restore", requireSession(), async (c) => {
    try {
      const record = await service().restoreRecord(
        serviceContextOf(c),
        c.req.param("slug"),
        c.req.param("id"),
      )
      return c.json({ data: record })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.get("/:slug/records/:id", requireSession(), async (c) => {
    try {
      const found = await service().getRecord(
        serviceContextOf(c),
        c.req.param("slug"),
        c.req.param("id"),
      )
      return c.json({ data: { ...found.record, object: found.object, fields: found.fields } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.patch(
    "/:slug/records/:id",
    requireSession(),
    zValidator("json", updateCustomObjectRecordSchema, invalidBody("Invalid request body")),
    async (c) => {
      try {
        const record = await service().updateRecord(
          serviceContextOf(c),
          c.req.param("slug"),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: record })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/:slug/records/:id", requireSession(), async (c) => {
    try {
      await service().deleteRecord(serviceContextOf(c), c.req.param("slug"), c.req.param("id"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/custom-objects": {
    get: {
      summary: "List custom object definitions",
      operationId: "listCustomObjects",
    },
    post: {
      summary: "Define a custom object (admin)",
      operationId: "createCustomObject",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createCustomObjectSchema) } },
      },
    },
  },
  "/api/v1/custom-objects/{slug}": {
    get: {
      summary: "Get a custom object definition with its fields",
      operationId: "getCustomObject",
    },
    patch: {
      summary: "Rename a custom object (the slug is immutable)",
      operationId: "updateCustomObject",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateCustomObjectSchema) } },
      },
    },
    delete: {
      summary: "Soft-delete a custom object definition",
      operationId: "deleteCustomObject",
    },
  },
  "/api/v1/custom-objects/{id}/restore": {
    post: {
      summary: "Restore a soft-deleted custom object",
      operationId: "restoreCustomObject",
    },
  },
  "/api/v1/custom-objects/{slug}/fields": {
    get: { summary: "List field definitions", operationId: "listCustomObjectFields" },
    post: {
      summary: "Add a field definition (admin)",
      operationId: "createCustomObjectField",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(createCustomObjectFieldSchema) } },
      },
    },
  },
  "/api/v1/custom-objects/{slug}/fields/{fieldId}": {
    patch: {
      summary: "Amend a field definition (type and key are immutable)",
      operationId: "updateCustomObjectField",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(updateCustomObjectFieldSchema) } },
      },
    },
    delete: {
      summary: "Soft-delete a field definition; stored values are preserved",
      operationId: "deleteCustomObjectField",
    },
  },
  "/api/v1/custom-objects/{slug}/records": {
    get: {
      summary: "List records of a custom object (cursor pagination, search, field filter)",
      operationId: "listCustomObjectRecords",
    },
    post: {
      summary: "Create a record, validated against the live field definitions",
      operationId: "createCustomObjectRecord",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(createCustomObjectRecordSchema) },
        },
      },
    },
  },
  "/api/v1/custom-objects/{slug}/records/{id}": {
    get: {
      summary: "Get a record with its object and fields",
      operationId: "getCustomObjectRecord",
    },
    patch: {
      summary: "Patch a record; values of deleted fields are preserved",
      operationId: "updateCustomObjectRecord",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(updateCustomObjectRecordSchema) },
        },
      },
    },
    delete: { summary: "Soft-delete a record", operationId: "deleteCustomObjectRecord" },
  },
  "/api/v1/custom-objects/{slug}/records/{id}/restore": {
    post: { summary: "Restore a soft-deleted record", operationId: "restoreCustomObjectRecord" },
  },
}

export {
  customObjectEnvelope,
  customObjectFieldSchema,
  customObjectListEnvelope,
  customObjectRecordListEnvelope,
}
