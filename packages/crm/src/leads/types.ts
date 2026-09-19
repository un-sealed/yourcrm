import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"
import type { ServiceContext } from "../index"

/**
 * Leads service ports + zod schemas (the pattern every module agent mirrors,
 * folded into one file — see index.ts).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository (`leads-repository.ts`) and
 * `writeAudit` to them. Any object with matching methods satisfies the
 * port — including the `createStore` fake in hermetic tests.
 *
 * Services validate inputs with the schemas below; API routes reuse them at
 * the HTTP boundary via `@hono/zod-validator`.
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type LeadRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type LeadListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
  source?: string
}

export type LeadListResult = {
  data: LeadRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type LeadsStore = {
  list(workspaceId: string, query: LeadListQuery): Promise<LeadListResult>
  findById(workspaceId: string, id: string): Promise<LeadRecord | null>
  create(workspaceId: string, input: Record<string, unknown>, actorId?: string): Promise<LeadRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<LeadRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type LeadAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type AuditWriter = (input: LeadAuditInput) => Promise<unknown>

export type EventEmitter = {
  emit(event: {
    event: string
    workspaceId: string
    actorId?: string
    entityType?: string
    entityId?: string
    before?: unknown
    after?: unknown
    correlationId?: string
  }): Promise<void>
}

export type LeadsServiceContext = ServiceContext

export type LeadsServiceDeps = {
  store: LeadsStore
  audit: AuditWriter
  events?: EventEmitter
}

const nameSchema = z.string().trim().min(1).max(255)

export const leadStatusSchema = z.enum(["new", "working", "qualified", "unqualified", "converted"])

export const leadSourceSchema = z.enum([
  "manual",
  "form",
  "meta",
  "google",
  "whatsapp",
  "indiamart",
  "justdial",
  "tradeindia",
])

export const createLeadSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema.nullish(),
  email: z.string().trim().email().max(320).nullish(),
  phone: z.string().trim().min(1).max(64).nullish(),
  companyName: z.string().trim().max(255).nullish(),
  title: z.string().trim().max(255).nullish(),
  source: leadSourceSchema.nullish(),
  status: leadStatusSchema.nullish(),
  score: z.number().int().min(0).max(100).nullish(),
  ownerId: z.string().min(1).nullish(),
  notes: z.string().max(10000).nullish(),
  personId: z.string().min(1).nullish(),
  companyId: z.string().min(1).nullish(),
  dealId: z.string().min(1).nullish(),
})

export type CreateLeadInput = z.infer<typeof createLeadSchema>

export const updateLeadSchema = createLeadSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateLeadInput = z.infer<typeof updateLeadSchema>

/**
 * Conversion targets. The actual Person/Company/Deal wiring is a later
 * integration pass — the service stores the ids only and emits
 * `lead.converted` with them.
 */
export const convertLeadSchema = z
  .object({
    personId: z.string().min(1).nullish(),
    companyId: z.string().min(1).nullish(),
    dealId: z.string().min(1).nullish(),
  })
  .partial()

export type ConvertLeadInput = z.infer<typeof convertLeadSchema>

export const leadQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: leadStatusSchema.optional(),
  source: leadSourceSchema.optional(),
})

export type LeadQuery = z.infer<typeof leadQuerySchema>

export const leadSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  companyName: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  source: z.string(),
  status: z.string(),
  score: z.number(),
  ownerId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  personId: z.string().nullable().optional(),
  companyId: z.string().nullable().optional(),
  dealId: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type LeadDto = z.infer<typeof leadSchema>
