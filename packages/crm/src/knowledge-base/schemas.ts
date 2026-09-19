import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"
import { KB_ARTICLE_STATUSES } from "./types"

/**
 * Knowledge Base zod schemas. Services validate inputs with these; API
 * routes reuse them at the HTTP boundary via `@hono/zod-validator`.
 *
 * Slug *content* rules (allowlist regex, reserved words) live in `slug.ts`
 * and are applied by the service — the same rule for HTTP, MCP and AI
 * callers (mirrors `custom-objects/schemas.ts`). These schemas only pin
 * shape and length at the boundary.
 */

export const kbSlugInputSchema = z.string().trim().toLowerCase().min(2).max(160)

export const kbArticleStatusSchema = z.enum(KB_ARTICLE_STATUSES)

export const createKbCategorySchema = z.object({
  name: z.string().trim().min(1).max(255),
  slug: kbSlugInputSchema,
  description: z.string().trim().max(2000).nullish(),
})

export type CreateKbCategoryInput = z.infer<typeof createKbCategorySchema>

export const updateKbCategorySchema = createKbCategorySchema
  .omit({ slug: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateKbCategoryInput = z.infer<typeof updateKbCategorySchema>

export const kbCategorySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type KbCategoryDto = z.infer<typeof kbCategorySchema>

/** `body` is markdown SOURCE TEXT — never rendered as trusted HTML (see the web app). */
export const createKbArticleSchema = z.object({
  title: z.string().trim().min(1).max(255),
  slug: kbSlugInputSchema,
  body: z.string().max(200_000).default(""),
  categoryId: z.string().min(1).nullish(),
})

export type CreateKbArticleInput = z.infer<typeof createKbArticleSchema>

export const updateKbArticleSchema = z
  .object({
    title: z.string().trim().min(1).max(255),
    slug: kbSlugInputSchema,
    body: z.string().max(200_000),
    categoryId: z.string().min(1).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateKbArticleInput = z.infer<typeof updateKbArticleSchema>

export const kbArticleQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: kbArticleStatusSchema.optional(),
  categoryId: z.string().min(1).optional(),
})

export type KbArticleQuery = z.infer<typeof kbArticleQuerySchema>

export const kbArticleSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  slug: z.string(),
  body: z.string(),
  status: z.string(),
  categoryId: z.string().nullable().optional(),
  authorId: z.string().nullable().optional(),
  publishedAt: z.unknown(),
  viewCount: z.number(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type KbArticleDto = z.infer<typeof kbArticleSchema>
