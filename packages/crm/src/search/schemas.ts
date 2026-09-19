import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"
import { SEARCH_OBJECT_TYPES, SEARCH_VISIBILITIES } from "./types"

/**
 * Global search zod schemas. The service validates with these; API routes
 * reuse them at the HTTP boundary via `@hono/zod-validator`.
 */

export const searchObjectTypeSchema = z.enum(SEARCH_OBJECT_TYPES)

export const searchVisibilitySchema = z.enum(SEARCH_VISIBILITIES)

/**
 * Query params for `GET /api/v1/search`.
 *
 * `sort`/`order` are dropped from the shared pagination schema on purpose:
 * results are ordered by full-text rank, not by a column, so offering a sort
 * key would be a lie. `limit` is capped at 100 (the shared default of 200 is
 * too many ranked rows to render in a palette).
 */
export const searchQuerySchema = paginationQuerySchema.omit({ sort: true, order: true }).extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  query: z.string().trim().min(1).max(255),
  object: searchObjectTypeSchema.optional(),
})

export type SearchQueryInput = z.infer<typeof searchQuerySchema>

/** Body for "index (or re-index) this record". */
export const searchIndexDocumentSchema = z.object({
  objectType: searchObjectTypeSchema,
  recordId: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(512),
  subtitle: z.string().trim().max(512).nullish(),
  body: z.string().max(100_000).nullish(),
  ownerId: z.string().trim().min(1).max(64).nullish(),
  visibility: searchVisibilitySchema.default("workspace"),
  recordUpdatedAt: z.string().datetime().nullish(),
})

export type SearchIndexDocumentInput = z.infer<typeof searchIndexDocumentSchema>

/** Identifies one indexed record (delete / lookup). */
export const searchDocumentRefSchema = z.object({
  objectType: searchObjectTypeSchema,
  recordId: z.string().trim().min(1).max(64),
})

export type SearchDocumentRef = z.infer<typeof searchDocumentRefSchema>

/** Response shape for a ranked hit (OpenAPI + envelope assertions). */
export const searchHitSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  objectType: z.string(),
  recordId: z.string(),
  title: z.string(),
  subtitle: z.string().nullable().optional(),
  snippet: z.string().nullable().optional(),
  rank: z.number(),
  ownerId: z.string().nullable().optional(),
  visibility: z.string().optional(),
  recordUpdatedAt: z.unknown(),
})

export type SearchHitDto = z.infer<typeof searchHitSchema>

/** Response shape for a stored index document. */
export const searchDocumentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  objectType: z.string(),
  recordId: z.string(),
  title: z.string(),
  subtitle: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  visibility: z.string(),
  recordUpdatedAt: z.unknown(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type SearchDocumentDto = z.infer<typeof searchDocumentSchema>
