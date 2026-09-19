import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"
import { reportAggregateFunctions, reportFilterOperatorSchema } from "../reports/schemas"

/**
 * Assistant zod schemas. Services validate inputs with these; API routes
 * reuse them at the HTTP boundary via `@hono/zod-validator`.
 *
 * The tool-argument schemas are the second gate on anything the *model*
 * produces: shape is checked here, and existence of every object and field
 * is checked against the schema-derived allowlist in the reports engine
 * (`resolveReportObject` / `resolveReportField`). No string a model emits
 * ever reaches SQL.
 */

const identifierSchema = z.string().trim().min(1).max(128)

export const AI_MESSAGE_MAX_LENGTH = 8000

export const createAiConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).nullish(),
  model: z.string().trim().min(1).max(128).nullish(),
})

export type CreateAiConversationInput = z.infer<typeof createAiConversationSchema>

export const updateAiConversationSchema = z.object({
  title: z.string().trim().min(1).max(200),
})

export type UpdateAiConversationInput = z.infer<typeof updateAiConversationSchema>

export const aiConversationQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
})

export type AiConversationQuery = z.infer<typeof aiConversationQuerySchema>

/** One question. `conversationId` absent ⇒ start a new conversation. */
export const askAiSchema = z.object({
  conversationId: z.string().min(1).max(64).nullish(),
  message: z.string().trim().min(1).max(AI_MESSAGE_MAX_LENGTH),
  /** Model override for this question. Recorded on the run for attribution. */
  model: z.string().trim().min(1).max(128).nullish(),
})

export type AskAiInput = z.infer<typeof askAiSchema>

/* ---------------------------- tool arguments --------------------------- */

/**
 * Flat condition list rather than the nested `FilterTree` the UI uses.
 * Same operators and the same compiler downstream — the service folds the
 * list into a one-level tree — but a flat list is dramatically easier for a
 * model to emit correctly, and a nested tree adds no expressive power the
 * assistant needs in P0.
 */
export const aiQueryFilterSchema = z.object({
  field: identifierSchema,
  operator: reportFilterOperatorSchema,
  value: z.unknown().optional(),
})

export const aiQueryToolArgsSchema = z.object({
  objectType: identifierSchema,
  filters: z.array(aiQueryFilterSchema).max(20).optional(),
  combinator: z.enum(["and", "or"]).optional(),
  groupBy: identifierSchema.optional(),
  aggregations: z
    .array(
      z.object({
        fn: z.enum(reportAggregateFunctions),
        field: identifierSchema.optional(),
        label: z.string().trim().max(128).optional(),
      }),
    )
    .max(5)
    .optional(),
  columns: z.array(identifierSchema).max(15).optional(),
  sort: z
    .array(z.object({ field: identifierSchema, direction: z.enum(["asc", "desc"]) }))
    .max(3)
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export type AiQueryToolArgs = z.infer<typeof aiQueryToolArgsSchema>

/* -------------------------------- DTOs --------------------------------- */

export const aiConversationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  userId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  lastMessageAt: z.unknown(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type AiConversationDto = z.infer<typeof aiConversationSchema>

export const aiMessageSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  conversationId: z.string(),
  role: z.string(),
  content: z.string(),
  model: z.string().nullable().optional(),
  providerId: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
  toolCalls: z.unknown().nullable().optional(),
  toolCallId: z.string().nullable().optional(),
  toolName: z.string().nullable().optional(),
  createdAt: z.unknown(),
})

export type AiMessageDto = z.infer<typeof aiMessageSchema>

export const aiRunSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  conversationId: z.string(),
  providerId: z.string(),
  model: z.string(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  latencyMs: z.number(),
  costMicros: z.number().nullable().optional(),
  outcome: z.string(),
  errorCode: z.string().nullable().optional(),
  toolCallCount: z.number(),
  createdAt: z.unknown(),
})

export type AiRunDto = z.infer<typeof aiRunSchema>

/** Non-secret description of the configured provider, for UI attribution. */
export const aiProviderStatusSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
})

export type AiProviderStatusDto = z.infer<typeof aiProviderStatusSchema>
