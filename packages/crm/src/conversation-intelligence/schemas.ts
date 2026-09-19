import { paginationQuerySchema } from "@yourcrm/validation"
import { z } from "zod"
import {
  CALL_TRANSCRIPT_MAX_CHARS,
  CALL_TRANSCRIPT_MAX_SEGMENTS,
  CALL_TRANSCRIPT_MAX_SEGMENT_CHARS,
} from "./transcript"
import {
  CALL_TRANSCRIPT_SOURCE_NAMES,
  CONVERSATION_ANALYSIS_STATUS_NAMES,
  CONVERSATION_ANALYSIS_TYPE_NAMES,
  CONVERSATION_SUBJECT_TYPE_NAMES,
} from "./types"

/**
 * Conversation-intelligence zod schemas (spec 37, P0).
 *
 * Services validate inputs with these; API routes reuse them at the HTTP
 * boundary via `@hono/zod-validator`, so there is one definition of what
 * a valid request is.
 *
 * The vocabulary is the canonical one for the domain layer and is
 * mirrored — never widened — in
 * `@yourcrm/database/src/schema/conversation-intelligence.ts` and in that
 * table's CHECK constraints. `@yourcrm/crm` has no database dependency,
 * so the lists cannot simply be imported; keep the three in step.
 *
 * Note what these schemas DO NOT accept: nowhere can a caller supply the
 * text to be analysed. The conversation is always fetched by id through
 * its owning module, under the caller's permissions. Accepting pasted
 * text "to analyse" would be a permission bypass with an AI label on it.
 */

export const conversationSubjectTypeSchema = z.enum(CONVERSATION_SUBJECT_TYPE_NAMES)

export const conversationAnalysisTypeSchema = z.enum(CONVERSATION_ANALYSIS_TYPE_NAMES)

export const conversationAnalysisStatusSchema = z.enum(CONVERSATION_ANALYSIS_STATUS_NAMES)

export const callTranscriptSourceSchema = z.enum(CALL_TRANSCRIPT_SOURCE_NAMES)

const subjectIdSchema = z.string().trim().min(1).max(128)

/* -------------------------------- queries -------------------------------- */

export const conversationAnalysisQuerySchema = paginationQuerySchema.extend({
  subjectType: conversationSubjectTypeSchema.optional(),
  subjectId: subjectIdSchema.optional(),
  analysisType: conversationAnalysisTypeSchema.optional(),
  status: conversationAnalysisStatusSchema.optional(),
})

export type ConversationAnalysisQuery = z.infer<typeof conversationAnalysisQuerySchema>

export const conversationSubjectRefSchema = z.object({
  subjectType: conversationSubjectTypeSchema,
  subjectId: subjectIdSchema,
})

export type ConversationSubjectRef = z.infer<typeof conversationSubjectRefSchema>

/* ------------------------------- requests -------------------------------- */

/**
 * Ask for an analysis. `types` is a set, not a free list: duplicates are
 * rejected rather than silently deduplicated, because a duplicate is a
 * caller bug that would otherwise cost real money twice.
 */
export const requestConversationAnalysisSchema = z.object({
  subjectType: conversationSubjectTypeSchema,
  subjectId: subjectIdSchema,
  types: z
    .array(conversationAnalysisTypeSchema)
    .min(1)
    .max(CONVERSATION_ANALYSIS_TYPE_NAMES.length)
    .refine((values) => new Set(values).size === values.length, {
      message: "each analysis type may be requested at most once",
    }),
  /** Override the provider's default model for this request. */
  model: z.string().trim().min(1).max(128).nullish(),
})

export type RequestConversationAnalysisInput = z.infer<typeof requestConversationAnalysisSchema>

/* ------------------------------- transcripts ------------------------------ */

export const callTranscriptSegmentSchema = z.object({
  speaker: z.string().trim().min(1).max(120),
  startMs: z.number().int().min(0).nullish(),
  endMs: z.number().int().min(0).nullish(),
  text: z.string().trim().min(1).max(CALL_TRANSCRIPT_MAX_SEGMENT_CHARS),
})

export type CallTranscriptSegmentInput = z.infer<typeof callTranscriptSegmentSchema>

/**
 * Ingest a transcript as TEXT — the speech-to-text seam (see
 * `transcript.ts`). Either `text` or at least one segment must be
 * present; when only segments are given the body is derived from them.
 */
export const ingestCallTranscriptSchema = z
  .object({
    subjectType: conversationSubjectTypeSchema.default("call"),
    subjectId: subjectIdSchema,
    source: callTranscriptSourceSchema,
    /** Notetaker / STT provider that produced it. Manual pastes omit it. */
    providerId: z.string().trim().min(1).max(64).nullish(),
    /** Provider transcript id. Makes webhook re-delivery idempotent. */
    externalId: z.string().trim().min(1).max(255).nullish(),
    language: z.string().trim().min(2).max(16).nullish(),
    text: z.string().max(CALL_TRANSCRIPT_MAX_CHARS).optional(),
    segments: z.array(callTranscriptSegmentSchema).max(CALL_TRANSCRIPT_MAX_SEGMENTS).optional(),
    durationMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 60 * 60 * 1000)
      .nullish(),
  })
  .superRefine((value, ctx) => {
    const hasText = value.text !== undefined && value.text.trim() !== ""
    const hasSegments = value.segments !== undefined && value.segments.length > 0
    if (!hasText && !hasSegments) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: "a transcript needs either text or at least one segment",
      })
    }
    if (value.source === "provider" && (value.providerId ?? "") === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerId"],
        message: "a provider transcript must name the provider that produced it",
      })
    }
  })

export type IngestCallTranscriptInput = z.infer<typeof ingestCallTranscriptSchema>

/* -------------------------------- proposals ------------------------------- */

/**
 * Propose ONE extracted action item as a task, through the spec 38
 * approval queue. There is deliberately no "create them all" input: a
 * bulk auto-create is the silent write this module exists to avoid.
 */
export const proposeConversationActionItemSchema = z.object({
  /** Index into the analysis's stored `output.items`. */
  itemIndex: z.number().int().min(0).max(100),
  /** Who the task would be assigned to. Null ⇒ the approver decides. */
  assigneeId: z.string().trim().min(1).max(128).nullish(),
  dueDate: z.string().trim().max(32).nullish(),
})

export type ProposeConversationActionItemInput = z.infer<typeof proposeConversationActionItemSchema>

/* ------------------------------- DTO shapes ------------------------------- */

export const conversationAnalysisSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  analysisType: z.string(),
  status: z.string(),
  providerId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
  output: z.unknown().optional(),
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  latencyMs: z.number().optional(),
  sourceChars: z.number().optional(),
  analysedChars: z.number().optional(),
  truncated: z.boolean().optional(),
  errorCode: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})

export type ConversationAnalysisDto = z.infer<typeof conversationAnalysisSchema>

export const callTranscriptSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  source: z.string(),
  providerId: z.string().nullable().optional(),
  externalId: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  text: z.string(),
  segments: z.unknown().optional(),
  durationMs: z.number().nullable().optional(),
  speakerCount: z.number().optional(),
  charCount: z.number().optional(),
  createdAt: z.string().optional(),
})

export type CallTranscriptDto = z.infer<typeof callTranscriptSchema>

export const conversationIntelligenceStatusSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  maxSourceChars: z.number(),
  maxOutputTokens: z.number(),
  analysisTypes: z.array(z.string()),
  subjectTypes: z.array(z.string()),
  queued: z.boolean(),
})

export type ConversationIntelligenceStatusDto = z.infer<typeof conversationIntelligenceStatusSchema>
