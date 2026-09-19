import { and, asc, desc, eq, ilike, isNull, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  aiConversations,
  aiMessages,
  aiRuns,
  isAiMessageRole,
  isAiRunOutcome,
  type AiConversation,
  type AiMessage,
  type AiRun,
  type NewAiMessage,
  type NewAiRun,
} from "../schema/ai"
import { createBaseRepository } from "./base-repository"

/**
 * AI assistant repository (spec 34-ai-assistant, P0). Tables in
 * `schema/ai.ts`, migration `0340_ai.sql`.
 *
 * Read-only as far as CRM data is concerned: this repository writes the
 * assistant's own three tables and nothing else. The answers themselves
 * come from the reports engine (`reports-repository.ts`), executed under
 * the caller's row scope — the assistant never gets its own query path
 * into another module's tables.
 *
 * Conversation listing is always narrowed by `AiConversationOwnerScope`.
 * The scope is derived from the session by the domain service and is a
 * required argument here, so "every conversation in the workspace" cannot
 * happen by forgetting a filter.
 */

/** Conversations a caller may see. Personal in P0 — see the service. */
export type AiConversationOwnerScope = { kind: "own"; actorId: string }

export type CreateAiConversationInput = {
  title: string
  userId?: string | null
  model?: string | null
}

export type UpdateAiConversationInput = {
  title?: string
  model?: string | null
  lastMessageAt?: Date | null
}

export type AppendAiMessageInput = {
  conversationId: string
  role: string
  content: string
  model?: string | null
  providerId?: string | null
  runId?: string | null
  toolCalls?: unknown
  toolCallId?: string | null
  toolName?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
}

export type RecordAiRunInput = {
  id: string
  conversationId: string
  messageId?: string | null
  actorId?: string | null
  providerId: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs: number
  costMicros?: number | null
  outcome: string
  errorCode?: string | null
  errorMessage?: string | null
  toolCallCount: number
  toolCalls?: unknown
  correlationId?: string | null
}

export class AiRepositoryError extends Error {
  readonly code = "INVALID_AI_RECORD"
  constructor(message: string) {
    super(message)
    this.name = "AiRepositoryError"
  }
}

/** Trimmed, non-empty title (max 255, mirrors the column). */
export function normalizeAiConversationTitle(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) {
    throw new AiRepositoryError("ai.conversation: title must not be empty")
  }
  return trimmed.length > 255 ? trimmed.slice(0, 255) : trimmed
}

export function validateAiMessageRole(value: string): string {
  if (!isAiMessageRole(value)) {
    throw new AiRepositoryError(
      `ai.message: role must be one of system, user, assistant, tool (got '${value}')`,
    )
  }
  return value
}

export function validateAiRunOutcome(value: string): string {
  if (!isAiRunOutcome(value)) {
    throw new AiRepositoryError(
      `ai.run: outcome must be one of succeeded, failed, denied (got '${value}')`,
    )
  }
  return value
}

/** Non-negative integer counter; anything else is a programming error. */
function counter(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new AiRepositoryError(`ai.run: ${field} must be a non-negative number`)
  }
  return Math.round(value)
}

export function toAiMessageValues(
  workspaceId: string,
  input: AppendAiMessageInput,
  actorId?: string,
): NewAiMessage {
  return {
    workspaceId,
    conversationId: input.conversationId,
    role: validateAiMessageRole(input.role),
    content: input.content,
    model: input.model ?? null,
    providerId: input.providerId ?? null,
    runId: input.runId ?? null,
    toolCalls: input.toolCalls ?? null,
    toolCallId: input.toolCallId ?? null,
    toolName: input.toolName ?? null,
    promptTokens: input.promptTokens ?? null,
    completionTokens: input.completionTokens ?? null,
    ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
  }
}

export function toAiRunValues(
  workspaceId: string,
  input: RecordAiRunInput,
  actorId?: string,
): NewAiRun {
  return {
    id: input.id,
    workspaceId,
    conversationId: input.conversationId,
    messageId: input.messageId ?? null,
    actorId: input.actorId ?? actorId ?? null,
    providerId: input.providerId,
    model: input.model,
    promptTokens: counter(input.promptTokens, "promptTokens"),
    completionTokens: counter(input.completionTokens, "completionTokens"),
    totalTokens: counter(input.totalTokens, "totalTokens"),
    latencyMs: counter(input.latencyMs, "latencyMs"),
    costMicros: input.costMicros ?? null,
    outcome: validateAiRunOutcome(input.outcome),
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    toolCallCount: counter(input.toolCallCount, "toolCallCount"),
    toolCalls: input.toolCalls ?? null,
    correlationId: input.correlationId ?? null,
    ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
  }
}

export function createAiRepository() {
  const conversations = createBaseRepository(aiConversations)

  return {
    async listConversations(
      db: Database,
      opts: {
        workspaceId: string
        scope: AiConversationOwnerScope
        limit?: number
        cursor?: string
        order?: "asc" | "desc"
        query?: string
      },
    ): Promise<{
      data: AiConversation[]
      pagination: { nextCursor: string | null; limit: number }
    }> {
      const where: SQL[] = [eq(aiConversations.userId, opts.scope.actorId)]
      if (opts.query !== undefined && opts.query.trim() !== "") {
        where.push(ilike(aiConversations.title, `%${opts.query.trim()}%`))
      }
      const result = await conversations.list(db, {
        workspaceId: opts.workspaceId,
        limit: opts.limit,
        cursor: opts.cursor,
        order: opts.order,
        where,
      })
      return { data: result.data as AiConversation[], pagination: result.pagination }
    },

    async findConversation(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<AiConversation | null> {
      return (await conversations.findById(db, workspaceId, id)) as AiConversation | null
    },

    async createConversation(
      db: Database,
      workspaceId: string,
      input: CreateAiConversationInput,
      actorId?: string,
    ): Promise<AiConversation> {
      const rows = await db
        .insert(aiConversations)
        .values({
          workspaceId,
          title: normalizeAiConversationTitle(input.title),
          userId: input.userId ?? actorId ?? null,
          model: input.model ?? null,
          lastMessageAt: new Date(),
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const created = rows[0]
      if (!created) throw new AiRepositoryError("ai.conversation: insert returned no row")
      return created
    },

    async updateConversation(
      db: Database,
      workspaceId: string,
      id: string,
      patch: UpdateAiConversationInput,
      actorId?: string,
    ): Promise<AiConversation | null> {
      const values: Record<string, unknown> = { updatedAt: new Date() }
      if (patch.title !== undefined) values.title = normalizeAiConversationTitle(patch.title)
      if (patch.model !== undefined) values.model = patch.model
      if (patch.lastMessageAt !== undefined) values.lastMessageAt = patch.lastMessageAt
      if (actorId !== undefined) values.updatedBy = actorId
      const rows = await db
        .update(aiConversations)
        .set(values)
        .where(
          and(
            eq(aiConversations.id, id),
            eq(aiConversations.workspaceId, workspaceId),
            isNull(aiConversations.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async softDeleteConversation(
      db: Database,
      workspaceId: string,
      id: string,
      actorId?: string,
    ): Promise<void> {
      await conversations.softDelete(db, workspaceId, id, actorId)
    },

    async listMessages(
      db: Database,
      workspaceId: string,
      conversationId: string,
      limit = 200,
    ): Promise<AiMessage[]> {
      const rows = await db
        .select()
        .from(aiMessages)
        .where(
          and(
            eq(aiMessages.workspaceId, workspaceId),
            eq(aiMessages.conversationId, conversationId),
            isNull(aiMessages.deletedAt),
          ),
        )
        .orderBy(asc(aiMessages.createdAt))
        .limit(Math.min(Math.max(limit, 1), 500))
      return rows
    },

    async appendMessage(
      db: Database,
      workspaceId: string,
      input: AppendAiMessageInput,
      actorId?: string,
    ): Promise<AiMessage> {
      const rows = await db
        .insert(aiMessages)
        .values(toAiMessageValues(workspaceId, input, actorId))
        .returning()
      const created = rows[0]
      if (!created) throw new AiRepositoryError("ai.message: insert returned no row")
      return created
    },

    async recordRun(
      db: Database,
      workspaceId: string,
      input: RecordAiRunInput,
      actorId?: string,
    ): Promise<AiRun> {
      const rows = await db
        .insert(aiRuns)
        .values(toAiRunValues(workspaceId, input, actorId))
        .returning()
      const created = rows[0]
      if (!created) throw new AiRepositoryError("ai.run: insert returned no row")
      return created
    },

    async listRuns(
      db: Database,
      workspaceId: string,
      conversationId: string,
      limit = 50,
    ): Promise<AiRun[]> {
      return db
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.workspaceId, workspaceId),
            eq(aiRuns.conversationId, conversationId),
            isNull(aiRuns.deletedAt),
          ),
        )
        .orderBy(desc(aiRuns.createdAt))
        .limit(Math.min(Math.max(limit, 1), 200))
    },
  }
}

export type AiRepository = ReturnType<typeof createAiRepository>
