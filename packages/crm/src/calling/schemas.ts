import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"
import { CALL_STATUSES } from "./status"

/**
 * Calling zod schemas. Services validate inputs with these; API routes reuse
 * them at the HTTP boundary via `@hono/zod-validator`. Phone numbers are
 * validated for shape only here — E.164 normalisation happens in the
 * repository (`calling-repository.ts`), same division of labour as
 * `people-repository.ts` (`validatePersonEmail`/`validatePersonPhone`).
 */

const CALL_DIRECTIONS = ["inbound", "outbound"] as const
const phoneInputSchema = z.string().trim().min(1).max(64)
const linkIdSchema = z.string().trim().min(1).nullish()

export const logCallSchema = z.object({
  direction: z.enum(CALL_DIRECTIONS),
  /** What happened. Manual logs default to "completed" — the call already occurred. */
  status: z.enum(CALL_STATUSES).default("completed"),
  fromNumber: phoneInputSchema,
  toNumber: phoneInputSchema,
  personId: linkIdSchema,
  companyId: linkIdSchema,
  dealId: linkIdSchema,
  ownerId: linkIdSchema,
  startedAt: z.coerce.date().nullish(),
  endedAt: z.coerce.date().nullish(),
  durationSeconds: z.coerce.number().int().min(0).max(86400).nullish(),
  disposition: z.string().trim().max(64).nullish(),
  notes: z.string().trim().max(10000).nullish(),
  /** Explicit, never defaults to true. */
  recordingConsent: z.boolean().default(false),
})

export type LogCallInput = z.infer<typeof logCallSchema>

export const placeCallSchema = z.object({
  toNumber: phoneInputSchema,
  /** Overrides the connection's configured caller id when supplied. */
  fromNumber: phoneInputSchema.nullish(),
  /** Which connected calling provider to use; auto-selected when omitted and exactly one is connected. */
  connectionId: z.string().trim().min(1).nullish(),
  personId: linkIdSchema,
  companyId: linkIdSchema,
  dealId: linkIdSchema,
  recordingConsent: z.boolean().default(false),
})

export type PlaceCallInput = z.infer<typeof placeCallSchema>

export const updateCallSchema = z
  .object({
    personId: linkIdSchema,
    companyId: linkIdSchema,
    dealId: linkIdSchema,
    ownerId: linkIdSchema,
    disposition: z.string().trim().max(64).nullish(),
    notes: z.string().trim().max(10000).nullish(),
    recordingConsent: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateCallInput = z.infer<typeof updateCallSchema>

export const callQuerySchema = paginationQuerySchema.extend({
  direction: z.enum(CALL_DIRECTIONS).optional(),
  status: z.enum(CALL_STATUSES).optional(),
  personId: z.string().trim().min(1).optional(),
  companyId: z.string().trim().min(1).optional(),
  dealId: z.string().trim().min(1).optional(),
  ownerId: z.string().trim().min(1).optional(),
  query: z.string().trim().max(255).optional(),
})

export type CallQuery = z.infer<typeof callQuerySchema>

export const addCallRecordingSchema = z.object({
  /** Storage key (`@yourcrm/storage`) or provider-hosted URL. Never bytes. */
  url: z.string().trim().min(1).max(2048),
  durationSeconds: z.coerce.number().int().min(0).max(86400).nullish(),
  sizeBytes: z.coerce.number().int().min(0).nullish(),
})

export type AddCallRecordingInput = z.infer<typeof addCallRecordingSchema>

export const callSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  ownerId: z.string().nullable().optional(),
  direction: z.string(),
  status: z.string(),
  source: z.string(),
  fromNumber: z.string(),
  toNumber: z.string(),
  personId: z.string().nullable().optional(),
  companyId: z.string().nullable().optional(),
  dealId: z.string().nullable().optional(),
  connectionId: z.string().nullable().optional(),
  providerId: z.string().nullable().optional(),
  providerCallId: z.string().nullable().optional(),
  startedAt: z.unknown().optional(),
  endedAt: z.unknown().optional(),
  durationSeconds: z.number().nullable().optional(),
  disposition: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  recordingConsent: z.boolean(),
  errorMessage: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type CallDto = z.infer<typeof callSchema>

export const callRecordingSchema = z.object({
  id: z.string(),
  callId: z.string(),
  url: z.string(),
  durationSeconds: z.number().nullable().optional(),
  sizeBytes: z.number().nullable().optional(),
  createdAt: z.unknown(),
})

export type CallRecordingDto = z.infer<typeof callRecordingSchema>
