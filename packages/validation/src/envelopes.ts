import { z } from "zod"

// ---------------------------------------------------------------------------
// Shared API envelopes (spec 01-architecture: consistent error + pagination).
// Every domain endpoint must use these shapes.
// ---------------------------------------------------------------------------

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
  cursor: z.string().optional(),
  sort: z.string().optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
})

export type PaginationQuery = z.infer<typeof paginationQuerySchema>

export const paginatedEnvelopeSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    pagination: z.object({
      nextCursor: z.string().nullable(),
      limit: z.number(),
    }),
  })

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
})

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>

export function errorEnvelope(
  code: string,
  message: string,
  requestId?: string,
  details?: unknown,
): ErrorEnvelope {
  return { error: { code, message, requestId, details } }
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const idSchema = z.string().min(1, "id is required")
export const workspaceIdSchema = z.string().min(1, "workspaceId is required")

export const baseRecordSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string().optional(),
  updatedBy: z.string().optional(),
  deletedAt: z.string().nullable().optional(),
})

export type BaseRecord = z.infer<typeof baseRecordSchema>
