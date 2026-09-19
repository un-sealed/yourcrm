import { and, asc, desc, eq, inArray, isNull, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  callTranscripts,
  conversationAnalyses,
  isCallTranscriptSource,
  isConversationAnalysisStatus,
  isConversationAnalysisType,
  isConversationSubjectType,
  type CallTranscriptRow,
  type ConversationAnalysisRow,
  type NewCallTranscriptRow,
  type NewConversationAnalysisRow,
} from "../schema/conversation-intelligence"
import { createBaseRepository } from "./base-repository"

/**
 * Conversation-intelligence repository (spec 37, P0). Tables in
 * `schema/conversation-intelligence.ts`, migration
 * `0410_conversation_intelligence.sql`.
 *
 * This repository touches its own two tables and nothing else. The
 * conversations being analysed belong to Email, WhatsApp and Calling, and
 * are read through THOSE modules' domain services — there is no join here
 * into a table this module does not own, which is both the layering rule
 * and the reason permission inheritance cannot be bypassed by a query.
 *
 * `listAnalyses` takes a `subjectTypes` allowlist as a REQUIRED argument,
 * derived by the domain service from the caller's permissions. "Every
 * analysis in the workspace" therefore cannot happen by forgetting a
 * filter — the worst a bug can do is pass an empty list and get nothing.
 */

export class ConversationIntelligenceRepositoryError extends Error {
  readonly code = "INVALID_CONVERSATION_INTELLIGENCE_RECORD"
  constructor(message: string) {
    super(message)
    this.name = "ConversationIntelligenceRepositoryError"
  }
}

function invalid(message: string): never {
  throw new ConversationIntelligenceRepositoryError(message)
}

export function validateConversationSubjectType(value: string): string {
  if (!isConversationSubjectType(value)) {
    invalid(
      `conversation_intelligence: subjectType must be one of email_thread, whatsapp_conversation, call (got '${value}')`,
    )
  }
  return value
}

export function validateConversationAnalysisType(value: string): string {
  if (!isConversationAnalysisType(value)) {
    invalid(
      `conversation_intelligence: analysisType must be one of summary, sentiment, action_items, key_topics (got '${value}')`,
    )
  }
  return value
}

export function validateConversationAnalysisStatus(value: string): string {
  if (!isConversationAnalysisStatus(value)) {
    invalid(
      `conversation_intelligence: status must be one of queued, succeeded, failed (got '${value}')`,
    )
  }
  return value
}

export function validateCallTranscriptSource(value: string): string {
  if (!isCallTranscriptSource(value)) {
    invalid(
      `conversation_intelligence: transcript source must be provider or manual (got '${value}')`,
    )
  }
  return value
}

/** Non-negative integer counter; anything else is a programming error. */
function counter(value: number | undefined, field: string): number {
  if (value === undefined) return 0
  if (!Number.isFinite(value) || value < 0) {
    invalid(`conversation_intelligence: ${field} must be a non-negative number`)
  }
  return Math.round(value)
}

export type CreateConversationAnalysisInput = {
  subjectType: string
  subjectId: string
  analysisType: string
  status?: string
  providerId?: string | null
  model?: string | null
  runId?: string | null
  output?: unknown
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  latencyMs?: number
  sourceChars?: number
  analysedChars?: number
  truncated?: boolean
  requestedBy?: string | null
  analysedAt?: Date | null
  errorCode?: string | null
  errorMessage?: string | null
  correlationId?: string | null
}

export type UpdateConversationAnalysisInput = {
  status?: string
  providerId?: string | null
  model?: string | null
  runId?: string | null
  output?: unknown
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  latencyMs?: number
  sourceChars?: number
  analysedChars?: number
  truncated?: boolean
  analysedAt?: Date | null
  errorCode?: string | null
  errorMessage?: string | null
}

export type ListConversationAnalysesOptions = {
  workspaceId: string
  /** Subject types the caller may read. Empty ⇒ empty page. Required. */
  subjectTypes: readonly string[]
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  subjectId?: string
  analysisType?: string
  status?: string
}

export type UpsertCallTranscriptInput = {
  subjectType?: string
  subjectId: string
  source: string
  providerId?: string | null
  externalId?: string | null
  language?: string | null
  text: string
  segments?: unknown
  durationMs?: number | null
  speakerCount?: number
  charCount?: number
}

export function toConversationAnalysisValues(
  workspaceId: string,
  input: CreateConversationAnalysisInput,
  actorId?: string,
): NewConversationAnalysisRow {
  return {
    workspaceId,
    subjectType: validateConversationSubjectType(input.subjectType),
    subjectId: input.subjectId,
    analysisType: validateConversationAnalysisType(input.analysisType),
    status: validateConversationAnalysisStatus(input.status ?? "queued"),
    providerId: input.providerId ?? null,
    model: input.model ?? null,
    runId: input.runId ?? null,
    output: input.output ?? null,
    promptTokens: counter(input.promptTokens, "promptTokens"),
    completionTokens: counter(input.completionTokens, "completionTokens"),
    totalTokens: counter(input.totalTokens, "totalTokens"),
    latencyMs: counter(input.latencyMs, "latencyMs"),
    sourceChars: counter(input.sourceChars, "sourceChars"),
    analysedChars: counter(input.analysedChars, "analysedChars"),
    truncated: input.truncated ?? false,
    requestedBy: input.requestedBy ?? actorId ?? null,
    analysedAt: input.analysedAt ?? null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    correlationId: input.correlationId ?? null,
    ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
  }
}

export function toCallTranscriptValues(
  workspaceId: string,
  input: UpsertCallTranscriptInput,
  actorId?: string,
): NewCallTranscriptRow {
  return {
    workspaceId,
    subjectType: validateConversationSubjectType(input.subjectType ?? "call"),
    subjectId: input.subjectId,
    source: validateCallTranscriptSource(input.source),
    providerId: input.providerId ?? null,
    externalId: input.externalId ?? null,
    language: input.language ?? null,
    text: input.text,
    segments: input.segments ?? null,
    durationMs: input.durationMs ?? null,
    speakerCount: counter(input.speakerCount, "speakerCount"),
    charCount: counter(input.charCount ?? input.text.length, "charCount"),
    ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
  }
}

export function createConversationIntelligenceRepository() {
  const analyses = createBaseRepository(conversationAnalyses)
  const transcripts = createBaseRepository(callTranscripts)

  return {
    async listAnalyses(
      db: Database,
      opts: ListConversationAnalysesOptions,
    ): Promise<{
      data: ConversationAnalysisRow[]
      pagination: { nextCursor: string | null; limit: number }
    }> {
      const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200)
      if (opts.subjectTypes.length === 0) {
        return { data: [], pagination: { nextCursor: null, limit } }
      }
      const where: SQL[] = [inArray(conversationAnalyses.subjectType, [...opts.subjectTypes])]
      if (opts.subjectId !== undefined) {
        where.push(eq(conversationAnalyses.subjectId, opts.subjectId))
      }
      if (opts.analysisType !== undefined) {
        where.push(
          eq(
            conversationAnalyses.analysisType,
            validateConversationAnalysisType(opts.analysisType),
          ),
        )
      }
      if (opts.status !== undefined) {
        where.push(eq(conversationAnalyses.status, validateConversationAnalysisStatus(opts.status)))
      }
      const result = await analyses.list(db, {
        workspaceId: opts.workspaceId,
        limit,
        cursor: opts.cursor,
        order: opts.order,
        where,
      })
      return { data: result.data as ConversationAnalysisRow[], pagination: result.pagination }
    },

    async findAnalysis(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<ConversationAnalysisRow | null> {
      return (await analyses.findById(db, workspaceId, id)) as ConversationAnalysisRow | null
    },

    async createAnalysis(
      db: Database,
      workspaceId: string,
      input: CreateConversationAnalysisInput,
      actorId?: string,
    ): Promise<ConversationAnalysisRow> {
      const rows = await db
        .insert(conversationAnalyses)
        .values(toConversationAnalysisValues(workspaceId, input, actorId))
        .returning()
      const created = rows[0]
      if (!created) invalid("conversation_analysis: insert returned no row")
      return created
    },

    async updateAnalysis(
      db: Database,
      workspaceId: string,
      id: string,
      patch: UpdateConversationAnalysisInput,
      actorId?: string,
    ): Promise<ConversationAnalysisRow | null> {
      const values: Record<string, unknown> = { updatedAt: new Date() }
      if (patch.status !== undefined) {
        values.status = validateConversationAnalysisStatus(patch.status)
      }
      if (patch.providerId !== undefined) values.providerId = patch.providerId
      if (patch.model !== undefined) values.model = patch.model
      if (patch.runId !== undefined) values.runId = patch.runId
      if (patch.output !== undefined) values.output = patch.output
      if (patch.promptTokens !== undefined) {
        values.promptTokens = counter(patch.promptTokens, "promptTokens")
      }
      if (patch.completionTokens !== undefined) {
        values.completionTokens = counter(patch.completionTokens, "completionTokens")
      }
      if (patch.totalTokens !== undefined) {
        values.totalTokens = counter(patch.totalTokens, "totalTokens")
      }
      if (patch.latencyMs !== undefined) values.latencyMs = counter(patch.latencyMs, "latencyMs")
      if (patch.sourceChars !== undefined) {
        values.sourceChars = counter(patch.sourceChars, "sourceChars")
      }
      if (patch.analysedChars !== undefined) {
        values.analysedChars = counter(patch.analysedChars, "analysedChars")
      }
      if (patch.truncated !== undefined) values.truncated = patch.truncated
      if (patch.analysedAt !== undefined) values.analysedAt = patch.analysedAt
      if (patch.errorCode !== undefined) values.errorCode = patch.errorCode
      if (patch.errorMessage !== undefined) values.errorMessage = patch.errorMessage
      if (actorId !== undefined) values.updatedBy = actorId
      const rows = await db
        .update(conversationAnalyses)
        .set(values)
        .where(
          and(
            eq(conversationAnalyses.id, id),
            eq(conversationAnalyses.workspaceId, workspaceId),
            isNull(conversationAnalyses.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async softDeleteAnalysis(
      db: Database,
      workspaceId: string,
      id: string,
      actorId?: string,
    ): Promise<void> {
      await analyses.softDelete(db, workspaceId, id, actorId)
    },

    async listTranscripts(
      db: Database,
      workspaceId: string,
      subjectType: string,
      subjectId: string,
      limit = 20,
    ): Promise<CallTranscriptRow[]> {
      return db
        .select()
        .from(callTranscripts)
        .where(
          and(
            eq(callTranscripts.workspaceId, workspaceId),
            eq(callTranscripts.subjectType, validateConversationSubjectType(subjectType)),
            eq(callTranscripts.subjectId, subjectId),
            isNull(callTranscripts.deletedAt),
          ),
        )
        .orderBy(desc(callTranscripts.createdAt))
        .limit(Math.min(Math.max(limit, 1), 100))
    },

    async findTranscript(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<CallTranscriptRow | null> {
      return (await transcripts.findById(db, workspaceId, id)) as CallTranscriptRow | null
    },

    /** Idempotency probe for provider re-delivery, on the provider's id. */
    async findTranscriptByExternalId(
      db: Database,
      workspaceId: string,
      externalId: string,
    ): Promise<CallTranscriptRow | null> {
      const rows = await db
        .select()
        .from(callTranscripts)
        .where(
          and(
            eq(callTranscripts.workspaceId, workspaceId),
            eq(callTranscripts.externalId, externalId),
            isNull(callTranscripts.deletedAt),
          ),
        )
        .orderBy(asc(callTranscripts.createdAt))
        .limit(1)
      return rows[0] ?? null
    },

    async createTranscript(
      db: Database,
      workspaceId: string,
      input: UpsertCallTranscriptInput,
      actorId?: string,
    ): Promise<CallTranscriptRow> {
      const rows = await db
        .insert(callTranscripts)
        .values(toCallTranscriptValues(workspaceId, input, actorId))
        .returning()
      const created = rows[0]
      if (!created) invalid("call_transcript: insert returned no row")
      return created
    },

    async softDeleteTranscript(
      db: Database,
      workspaceId: string,
      id: string,
      actorId?: string,
    ): Promise<void> {
      await transcripts.softDelete(db, workspaceId, id, actorId)
    },
  }
}

export type ConversationIntelligenceRepository = ReturnType<
  typeof createConversationIntelligenceRepository
>
