import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"
import { CUSTOM_OBJECT_FIELD_TYPES } from "./field-schema"

/**
 * Static zod schemas for the custom-objects METADATA api (objects and field
 * definitions). The record payload itself has no static schema — it is
 * built at runtime from the field definitions, see `field-schema.ts`.
 *
 * Slug and field-key *content* rules live in `naming.ts` and are applied by
 * the service, so the same rule holds for HTTP, MCP and AI callers. These
 * schemas only pin shape and length at the boundary.
 */

export const customObjectSlugInputSchema = z.string().trim().toLowerCase().min(2).max(64)

export const createCustomObjectSchema = z
  .object({
    slug: customObjectSlugInputSchema,
    name: z.string().trim().min(1).max(128),
    /** Defaults to `name` + "s" when omitted. */
    pluralName: z.string().trim().min(1).max(128).optional(),
    icon: z.string().trim().max(64).nullish(),
    description: z.string().trim().max(2000).nullish(),
  })
  .strict()

export type CreateCustomObjectInput = z.infer<typeof createCustomObjectSchema>

/**
 * `slug` is absent on purpose. It is the join key to
 * `custom_field_definitions.object_type` and it appears in API paths, so it
 * is immutable; `.strict()` turns an attempt to change it into an explicit
 * 400 rather than a silent no-op.
 */
export const updateCustomObjectSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    pluralName: z.string().trim().min(1).max(128),
    icon: z.string().trim().max(64).nullable(),
    description: z.string().trim().max(2000).nullable(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateCustomObjectInput = z.infer<typeof updateCustomObjectSchema>

export const customObjectFieldTypeSchema = z.enum(CUSTOM_OBJECT_FIELD_TYPES)

export const customObjectFieldOptionSchema = z.union([
  z.string().trim().min(1).max(128),
  z
    .object({
      value: z.string().trim().min(1).max(128),
      label: z.string().trim().max(128).optional(),
    })
    .strict(),
])

/** A default value must be a JSON scalar or a list of strings. */
export const customObjectFieldDefaultSchema = z.union([
  z.string().max(10_000),
  z.number(),
  z.boolean(),
  z.array(z.string().max(128)).max(200),
])

export const createCustomObjectFieldSchema = z
  .object({
    key: z.string().trim().min(1).max(128),
    label: z.string().trim().min(1).max(255),
    fieldType: customObjectFieldTypeSchema,
    options: z.array(customObjectFieldOptionSchema).max(200).nullish(),
    required: z.boolean().default(false),
    displayOrder: z.number().int().min(0).max(9999).default(0),
    defaultValue: customObjectFieldDefaultSchema.nullish(),
  })
  .strict()

export type CreateCustomObjectFieldInput = z.infer<typeof createCustomObjectFieldSchema>

/**
 * `key` and `fieldType` are absent on purpose — see
 * `CustomObjectsService.updateField`. Changing a field's type in place
 * would reinterpret every value already stored under that key, so the
 * engine refuses: `.strict()` makes the attempt a 400 with a message
 * naming the unrecognized key instead of a silently ignored patch.
 */
export const updateCustomObjectFieldSchema = z
  .object({
    label: z.string().trim().min(1).max(255),
    options: z.array(customObjectFieldOptionSchema).max(200).nullable(),
    required: z.boolean(),
    displayOrder: z.number().int().min(0).max(9999),
    defaultValue: customObjectFieldDefaultSchema.nullable(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateCustomObjectFieldInput = z.infer<typeof updateCustomObjectFieldSchema>

export const customObjectQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
})

export type CustomObjectQuery = z.infer<typeof customObjectQuerySchema>

/**
 * Record list query. `field`/`value` express one exact field filter; the
 * service checks `field` against the object's live definitions before it
 * becomes a jsonb containment test, and the value is always parameter-bound.
 */
export const customObjectRecordQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  field: z.string().trim().max(128).optional(),
  value: z.string().trim().max(255).optional(),
})

export type CustomObjectRecordQuery = z.infer<typeof customObjectRecordQuerySchema>

/**
 * `values` is `z.unknown()`, NOT `z.record(...)`, and that is deliberate.
 * A `z.record` rebuilds the object by assignment, and assigning to
 * `__proto__` sets a prototype instead of creating an own property — the
 * hostile key would vanish from the payload before the strict runtime
 * schema ever got to reject it. Passing the value through untouched lets
 * `parseCustomObjectRecordValues` see every key the client actually sent.
 */
export const createCustomObjectRecordSchema = z
  .object({
    ownerId: z.string().min(1).nullish(),
    /** Validated at runtime against the object's field definitions. */
    values: z.unknown(),
  })
  .strict()

export type CreateCustomObjectRecordInput = z.infer<typeof createCustomObjectRecordSchema>

/** See `createCustomObjectRecordSchema` for why `values` stays `unknown`. */
export const updateCustomObjectRecordSchema = z
  .object({
    ownerId: z.string().min(1).nullable(),
    values: z.unknown(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateCustomObjectRecordInput = z.infer<typeof updateCustomObjectRecordSchema>

/** Response shape for an object definition (envelope `data`). */
export const customObjectSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  slug: z.string(),
  name: z.string(),
  pluralName: z.string(),
  icon: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type CustomObjectDto = z.infer<typeof customObjectSchema>

/** Response shape for a field definition. */
export const customObjectFieldSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  objectType: z.string(),
  key: z.string(),
  label: z.string(),
  fieldType: z.string(),
  options: z.unknown().optional(),
  defaultValue: z.unknown().optional(),
  required: z.boolean(),
  displayOrder: z.number(),
})

export type CustomObjectFieldDto = z.infer<typeof customObjectFieldSchema>

/** Response shape for a record. */
export const customObjectRecordSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  objectId: z.string(),
  ownerId: z.string().nullable().optional(),
  displayName: z.string(),
  fieldValues: z.record(z.unknown()),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type CustomObjectRecordDto = z.infer<typeof customObjectRecordSchema>
