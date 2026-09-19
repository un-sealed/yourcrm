import { AiEvents, createEvent, getEventBus } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import {
  CALL_TRANSCRIPT_OBJECT,
  CONVERSATION_ANALYSIS_OBJECT,
  conversationPermission,
  conversationSubjectPermission,
  readableConversationSubjectTypes,
} from "./access"
import {
  boundConversationSource,
  CONVERSATION_ANALYSIS_MAX_OUTPUT_TOKENS,
  CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS,
  CONVERSATION_ANALYSIS_MAX_TYPES_PER_REQUEST,
  type BoundedConversationText,
} from "./bounds"
import {
  buildConversationAnalysisMessages,
  conversationActionItemsOf,
  isEmptyConversationAnalysisOutput,
  parseConversationAnalysisOutput,
} from "./prompt"
import {
  containsConversationContent,
  containsConversationTerms,
  redactConversationContent,
  redactConversationTerms,
} from "./redaction"
import {
  callTranscriptSourceSchema,
  conversationAnalysisQuerySchema,
  ingestCallTranscriptSchema,
  proposeConversationActionItemSchema,
  requestConversationAnalysisSchema,
} from "./schemas"
import {
  callTranscriptSpeakers,
  callTranscriptTextFromSegments,
  normalizeCallTranscriptSegments,
  CALL_TRANSCRIPT_MAX_CHARS,
} from "./transcript"
import {
  CONVERSATION_ANALYSIS_TYPE_NAMES,
  type CallTranscriptRecord,
  type ConversationActionItem,
  type ConversationAnalysisDetail,
  type ConversationAnalysisListResult,
  type ConversationAnalysisRecord,
  type ConversationAnalysisSubject,
  type ConversationAnalysisType,
  type ConversationIntelligenceAuditInput,
  type ConversationIntelligenceServiceContext,
  type ConversationIntelligenceServiceDeps,
  type ConversationSource,
  type ConversationSubjectType,
} from "./types"
import type { AiActionRequestOutcome } from "../ai-governance/types"

/**
 * Conversation intelligence (spec 37-ai-conversation-intelligence, P0).
 *
 * Turns a conversation somebody else owns into structured CRM data: a
 * summary, a sentiment signal with a caveat, extracted action items and
 * the key topics. Every method calls `requirePermission()` first, then
 * resolves the conversation through its OWNING module, then works through
 * the injected ports.
 *
 * Four properties this module is built to keep. Each one has a test with
 * the same name in `service.test.ts`.
 *
 * ## 1. Permission inheritance
 *
 * An analysis is readable exactly when its subject is readable, decided
 * at READ TIME, never copied into a column. Two gates, both on every
 * path: the object gate in `access.ts` (`read` on `conversation_analysis`
 * AND on the subject's own object — `email_thread`, `call`, …), then the
 * record gate — `ConversationSourcePort.load` under the caller's context,
 * which runs the owning module's own `requirePermission()` and visibility
 * rules. A user who cannot read the thread gets 404 for its summary, and
 * the row never appears in their list.
 *
 * ## 2. No silent writes
 *
 * There is no code path in this file that mutates another module's
 * record. An extracted action item is DATA: it lives in
 * `conversation_analyses.output` and the user does what they like with
 * it. The single path from an item to a task is
 * `proposeConversationActionItem`, which calls spec 38's
 * `requestAction()` and returns a PENDING request. Nothing is created
 * until a human approves it, and the approval, the apply and the undo all
 * belong to `../ai-governance`. With no governance port wired the method
 * refuses — it never falls back to writing.
 *
 * ## 3. Bounded cost
 *
 * Conversation text is unbounded and tokens are billed. `bounds.ts` caps
 * every request at {@link CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS}
 * characters (≈6 000 prompt tokens) by deterministic head-and-tail
 * truncation before a provider is reachable, the completion is capped at
 * {@link CONVERSATION_ANALYSIS_MAX_OUTPUT_TOKENS} (2 000), and a request
 * may ask for at most the four analysis types — ≈32 800 tokens for the
 * largest possible single request. Each row records what was actually
 * spent — `sourceChars`, `analysedChars`, `truncated`, and the provider's
 * own reported `promptTokens` / `completionTokens` / `totalTokens`.
 *
 * ## 4. PII stays put
 *
 * Audit rows and events carry METADATA ONLY — subject, analysis type,
 * model, provider, run id, outcome, tokens. Never prompt text, never
 * transcript text, never the model's answer. Every error string that
 * could have touched the conversation goes through
 * `redactConversationContent` before it is stored or raised, and the
 * failure path asserts the result is clean before writing it. Nothing in
 * this module logs.
 *
 * ## Analysis is on-demand or queued, never inline in a request
 *
 * `analyzeConversation` is the explicit, user-initiated path: a person
 * pressed a button and is waiting. Everything else goes through
 * `queueConversationAnalysis`, which persists `queued` rows and hands
 * them to the BullMQ seam (`ConversationAnalysisQueuePort`, bound in the
 * composition root); the worker calls `runQueuedConversationAnalysis`
 * with the requester's inherited context. No inbound webhook, no event
 * handler and no list view ever triggers a provider call in the request
 * path. Domain code does not import BullMQ.
 *
 * ## BLOCKER — missing event constants
 *
 * Spec 37 §9 names `transcript.ready`, `insight.created` and
 * `action_item.created`. `@yourcrm/events` defines none of them, and this
 * agent may not edit that package (a missing constant is a blocker to
 * report, not to add). Completed analyses therefore emit the existing
 * `AiEvents.AgentCompleted` with `entityType: "conversation_analysis"` —
 * true, already consumed by AI usage tooling, and not a second vocabulary.
 * Adding the three constants is a change to this file alone.
 */

/* -------------------------------- errors -------------------------------- */

export class ConversationAnalysisNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`conversation analysis ${id} not found`)
    this.name = "ConversationAnalysisNotFoundError"
  }
}

/**
 * The conversation does not exist, or the caller may not read it. ONE
 * error for both on purpose — see the header of `sources.ts`.
 */
export class ConversationSubjectNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(subjectType: string, subjectId: string) {
    super(`${subjectType} ${subjectId} not found`)
    this.name = "ConversationSubjectNotFoundError"
  }
}

/** No source adapter registered for this subject type in this deployment. */
export class ConversationSourceUnavailableError extends Error {
  readonly code = "CONVERSATION_SOURCE_UNAVAILABLE"
  constructor(subjectType: string) {
    super(`no conversation source is configured for ${subjectType}`)
    this.name = "ConversationSourceUnavailableError"
  }
}

/** The conversation has no text yet (e.g. a call awaiting its transcript). */
export class ConversationSourceEmptyError extends Error {
  readonly code = "CONVERSATION_SOURCE_EMPTY"
  constructor(subjectType: string, subjectId: string) {
    super(`${subjectType} ${subjectId} has no conversation text to analyse yet`)
    this.name = "ConversationSourceEmptyError"
  }
}

export class ConversationAnalysisQueueUnavailableError extends Error {
  readonly code = "CONVERSATION_QUEUE_UNAVAILABLE"
  constructor() {
    super("no background queue is configured, so analyses cannot be queued")
    this.name = "ConversationAnalysisQueueUnavailableError"
  }
}

export class ConversationGovernanceUnavailableError extends Error {
  readonly code = "CONVERSATION_GOVERNANCE_UNAVAILABLE"
  constructor() {
    super("no AI approval queue is configured, so an action item cannot be proposed")
    this.name = "ConversationGovernanceUnavailableError"
  }
}

export class ConversationActionItemNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(index: number) {
    super(`this analysis has no action item at index ${String(index)}`)
    this.name = "ConversationActionItemNotFoundError"
  }
}

/** Provider failure. The message is already redacted of source text. */
export class ConversationAnalysisFailedError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "ConversationAnalysisFailedError"
    this.code = code
  }
}

/* ------------------------------- helpers -------------------------------- */

const DEFAULT_TRANSCRIPT_LIST_LIMIT = 20

/** The object type a proposed action item would create. */
export const CONVERSATION_ACTION_ITEM_OBJECT_TYPE = "task"

/** The model hit `maxOutputTokens` before finishing. See `runOne`. */
export const CONVERSATION_RESPONSE_TRUNCATED_CODE = "AI_PROVIDER_RESPONSE_TRUNCATED"

/** Identifies this module as the proposer in the spec 38 approval queue. */
export const CONVERSATION_INTELLIGENCE_AGENT_ID = "conversation-intelligence"

function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown }).code
  return typeof code === "string" ? code : "AI_PROVIDER_UNAVAILABLE"
}

/** True for `null`/`undefined`/blank, which every optional field treats alike. */
function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === ""
}

/**
 * The audit/event payload for an analysis. METADATA ONLY — deliberately
 * constructed field by field rather than spread from the row, so a column
 * added later (an `output` cache, a snippet) cannot leak into the audit
 * trail by accident. Property 4.
 */
export function conversationAnalysisAuditPayload(
  analysis: ConversationAnalysisRecord,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    analysisId: analysis.id,
    subjectType: analysis.subjectType,
    subjectId: analysis.subjectId,
    analysisType: analysis.analysisType,
    status: analysis.status,
    providerId: analysis.providerId ?? null,
    model: analysis.model ?? null,
    runId: analysis.runId ?? null,
    promptTokens: analysis.promptTokens ?? 0,
    completionTokens: analysis.completionTokens ?? 0,
    totalTokens: analysis.totalTokens ?? 0,
    sourceChars: analysis.sourceChars ?? 0,
    analysedChars: analysis.analysedChars ?? 0,
    truncated: analysis.truncated ?? false,
    ...extra,
  }
}

function subjectTypeOf(analysis: ConversationAnalysisRecord): ConversationSubjectType {
  // Stored values are validated on the way in (zod at the boundary, the
  // repository allowlist and a CHECK constraint at the table), so this is
  // a narrowing, not a trust decision.
  return analysis.subjectType as ConversationSubjectType
}

function analysisTypeOf(analysis: ConversationAnalysisRecord): ConversationAnalysisType {
  return analysis.analysisType as ConversationAnalysisType
}

/** The subject block the detail view renders, with its cost facts. */
function describeSubject(
  source: ConversationSource,
  bounded: BoundedConversationText,
): ConversationAnalysisSubject {
  return {
    subjectType: source.subjectType,
    subjectId: source.subjectId,
    title: source.title,
    participants: source.participants,
    occurredAt: source.occurredAt,
    turns: source.turns,
    sourceChars: bounded.sourceChars,
    analysedChars: bounded.analysedChars,
    truncated: bounded.truncated,
  }
}

/* ------------------------------- service -------------------------------- */

export function createConversationIntelligenceService(deps: ConversationIntelligenceServiceDeps) {
  const events = deps.events ?? getEventBus()
  const now = deps.now ?? (() => new Date())
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const maxSourceChars = deps.maxSourceChars ?? CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS
  const maxOutputTokens = deps.maxOutputTokens ?? CONVERSATION_ANALYSIS_MAX_OUTPUT_TOKENS
  const maxTypesPerRequest = deps.maxTypesPerRequest ?? CONVERSATION_ANALYSIS_MAX_TYPES_PER_REQUEST

  /**
   * Both gates for one subject, in order: object first (so a caller with
   * no access to calls at all gets 403, not 404), then record.
   *
   * Returns the conversation, or throws. This is the ONLY way any method
   * here obtains conversation text — there is no path that accepts text
   * from a caller and no path that reads a source without it.
   */
  async function loadSubject(
    ctx: ConversationIntelligenceServiceContext,
    subjectType: ConversationSubjectType,
    subjectId: string,
  ): Promise<ConversationSource> {
    requirePermission(conversationSubjectPermission(ctx, subjectType))
    const source = deps.sources.get(subjectType)
    if (!source) throw new ConversationSourceUnavailableError(subjectType)
    const loaded = await source.load(ctx, subjectId)
    if (!loaded) throw new ConversationSubjectNotFoundError(subjectType, subjectId)
    return loaded
  }

  /** An analysis row plus a re-resolved, still-visible subject. */
  async function loadVisibleAnalysis(
    ctx: ConversationIntelligenceServiceContext,
    id: string,
  ): Promise<{ analysis: ConversationAnalysisRecord; source: ConversationSource }> {
    const analysis = await deps.store.findAnalysis(ctx.workspaceId, id)
    if (!analysis) throw new ConversationAnalysisNotFoundError(id)
    const subjectType = subjectTypeOf(analysis)
    let source: ConversationSource
    try {
      source = await loadSubject(ctx, subjectType, analysis.subjectId)
    } catch (err) {
      // Property 1. A caller who may not read the conversation may not
      // learn that an analysis of it exists either, so a record-level
      // refusal becomes "no such analysis" rather than "forbidden on a
      // row I just told you about".
      if (err instanceof ConversationSubjectNotFoundError) {
        throw new ConversationAnalysisNotFoundError(id)
      }
      throw err
    }
    return { analysis, source }
  }

  async function audit(
    ctx: ConversationIntelligenceServiceContext,
    action: string,
    object: string,
    recordId: string,
    after: Record<string, unknown>,
    source: ConversationIntelligenceAuditInput["source"] = "ai",
  ): Promise<void> {
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action,
      object,
      recordId,
      after,
      correlationId: ctx.correlationId,
      source,
    })
  }

  /* ------------------------------- reads ------------------------------- */

  /**
   * List analyses.
   *
   * Two-stage filtering, both stages required:
   *  1. the store is given the subject types the caller may read — an
   *     unreadable channel's rows never leave the database;
   *  2. the surviving rows are grouped by subject type and passed through
   *     the owning module's `filterReadable`, one call per type, so a row
   *     whose conversation is hidden at RECORD level is dropped too.
   *
   * Stage 2 can shorten a page. That is the deliberate trade: `nextCursor`
   * still comes from the store so paging terminates correctly, and a
   * hidden analysis is never returned. Uniform page length is not worth a
   * leak.
   */
  async function listAnalyses(
    ctx: ConversationIntelligenceServiceContext,
    rawQuery: unknown,
  ): Promise<ConversationAnalysisListResult> {
    requirePermission(conversationPermission(ctx, "read"))
    const query = conversationAnalysisQuerySchema.parse(rawQuery ?? {})
    const subjectTypes = readableConversationSubjectTypes(ctx, deps.sources, query.subjectType)
    if (subjectTypes.length === 0) {
      return { data: [], pagination: { nextCursor: null, limit: query.limit } }
    }
    const page = await deps.store.listAnalyses(ctx.workspaceId, query, subjectTypes)

    const visibleBySubjectType = new Map<ConversationSubjectType, Set<string>>()
    for (const subjectType of subjectTypes) {
      const ids = [
        ...new Set(
          page.data.filter((row) => row.subjectType === subjectType).map((row) => row.subjectId),
        ),
      ]
      if (ids.length === 0) continue
      const source = deps.sources.get(subjectType)
      const readable = source === null ? [] : await source.filterReadable(ctx, ids)
      visibleBySubjectType.set(subjectType, new Set(readable))
    }

    return {
      data: page.data.filter(
        (row) => visibleBySubjectType.get(subjectTypeOf(row))?.has(row.subjectId) ?? false,
      ),
      pagination: page.pagination,
    }
  }

  async function getAnalysis(
    ctx: ConversationIntelligenceServiceContext,
    id: string,
  ): Promise<ConversationAnalysisDetail> {
    requirePermission(conversationPermission(ctx, "read"))
    const { analysis, source } = await loadVisibleAnalysis(ctx, id)
    const bounded = boundConversationSource(source, maxSourceChars)
    return { analysis, subject: describeSubject(source, bounded) }
  }

  /** Every analysis of one conversation, for the conversation's own view. */
  async function listAnalysesForSubject(
    ctx: ConversationIntelligenceServiceContext,
    subjectType: ConversationSubjectType,
    subjectId: string,
  ): Promise<ConversationAnalysisListResult> {
    requirePermission(conversationPermission(ctx, "read"))
    // Full subject resolution, not just the object gate: this is a read of
    // one conversation's derived data.
    await loadSubject(ctx, subjectType, subjectId)
    return deps.store.listAnalyses(ctx.workspaceId, { subjectType, subjectId }, [subjectType])
  }

  async function listTranscripts(
    ctx: ConversationIntelligenceServiceContext,
    subjectType: ConversationSubjectType,
    subjectId: string,
  ): Promise<CallTranscriptRecord[]> {
    requirePermission(conversationPermission(ctx, "read", CALL_TRANSCRIPT_OBJECT))
    await loadSubject(ctx, subjectType, subjectId)
    return deps.store.listTranscripts(
      ctx.workspaceId,
      subjectType,
      subjectId,
      DEFAULT_TRANSCRIPT_LIST_LIMIT,
    )
  }

  /** Non-secret description of the configured provider and its limits. */
  function describeStatus(ctx: ConversationIntelligenceServiceContext) {
    requirePermission(conversationPermission(ctx, "read"))
    return {
      providerId: deps.provider.id,
      model: deps.provider.defaultModel,
      maxSourceChars,
      maxOutputTokens,
      analysisTypes: [...CONVERSATION_ANALYSIS_TYPE_NAMES],
      subjectTypes: readableConversationSubjectTypes(ctx, deps.sources),
      queued: deps.queue !== undefined,
    }
  }

  /* ------------------------------ analysis ----------------------------- */

  /**
   * Run one analysis against an already-bounded conversation and close its
   * row. The only place in the module that calls the provider.
   */
  async function runOne(
    ctx: ConversationIntelligenceServiceContext,
    analysis: ConversationAnalysisRecord,
    source: ConversationSource,
    bounded: BoundedConversationText,
    model: string | null,
  ): Promise<ConversationAnalysisRecord> {
    const analysisType = analysisTypeOf(analysis)
    const messages = buildConversationAnalysisMessages({ analysisType, source, bounded })
    const startedAt = now()

    try {
      const completion = await deps.provider.complete(messages, {
        ...(model === null ? {} : { model }),
        maxOutputTokens,
        ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
      })
      const output = parseConversationAnalysisOutput(analysisType, completion.text)
      /**
       * An answer cut off by `maxOutputTokens` parses into the same empty
       * shape as an honest "nothing found" — and a confidently empty
       * action-item list is worse than a visible failure, because a user
       * acts on it. A REAL provider run found exactly this (a reasoning
       * model spent the whole output budget and was cut mid-JSON), so the
       * two cases are separated here: the truncation is always recorded,
       * and an empty truncated answer is a FAILURE, not a finding.
       */
      const cutOff = completion.finishReason === "length"
      const empty = isEmptyConversationAnalysisOutput(output)
      const updated = await deps.store.updateAnalysis(
        ctx.workspaceId,
        analysis.id,
        {
          status: cutOff && empty ? "failed" : "succeeded",
          providerId: completion.providerId,
          model: completion.model,
          output,
          promptTokens: completion.usage.promptTokens,
          completionTokens: completion.usage.completionTokens,
          totalTokens: completion.usage.totalTokens,
          latencyMs: completion.latencyMs,
          analysedAt: startedAt,
          errorCode: cutOff ? CONVERSATION_RESPONSE_TRUNCATED_CODE : null,
          errorMessage: null,
        },
        ctx.actorId,
      )
      if (!updated) throw new ConversationAnalysisNotFoundError(analysis.id)
      if (cutOff && empty) {
        throw new ConversationAnalysisFailedError(
          CONVERSATION_RESPONSE_TRUNCATED_CODE,
          "the model ran out of output budget before it finished answering",
        )
      }

      await events.emit(
        createEvent({
          // BLOCKER: no `insight.created` constant exists — see the header.
          event: AiEvents.AgentCompleted,
          workspaceId: ctx.workspaceId,
          actorId: ctx.actorId,
          actorType: "ai",
          entityType: CONVERSATION_ANALYSIS_OBJECT,
          entityId: updated.id,
          after: conversationAnalysisAuditPayload(updated),
          ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
        }),
      )
      await audit(ctx, "analyze", CONVERSATION_ANALYSIS_OBJECT, updated.id, {
        ...conversationAnalysisAuditPayload(updated),
        latencyMs: completion.latencyMs,
        outcome: "succeeded",
      })
      return updated
    } catch (err) {
      // Property 4. The provider's message may quote the prompt, which is
      // the conversation. Redact against BOTH the bounded text that was
      // sent and the raw turns, then verify — and drop the message
      // entirely if anything survived.
      const code = errorCodeOf(err)
      const raw = err instanceof Error ? err.message : String(err)
      // Every form the content could have been quoted in: the prompt we
      // sent, the bare turn text, and the speaker-prefixed rendering.
      const rawTurns = source.turns.map((turn) => turn.text).join("\n")
      const prefixedTurns = source.turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n")
      // Names are under the quotation window and need the exact-term rule.
      const terms = [
        ...source.participants,
        ...source.turns.map((turn) => turn.speaker),
        source.title,
      ]
      const redacted = redactConversationTerms(
        redactConversationContent(raw, bounded.text, rawTurns, prefixedTurns, source.title),
        terms,
      )
      const leaked =
        containsConversationContent(redacted, bounded.text, rawTurns, prefixedTurns) ||
        containsConversationTerms(redacted, terms)
      const safeMessage = leaked
        ? `${code} (message withheld: it contained conversation content)`
        : redacted

      const failed = await deps.store.updateAnalysis(
        ctx.workspaceId,
        analysis.id,
        {
          status: "failed",
          analysedAt: startedAt,
          errorCode: code,
          errorMessage: safeMessage,
        },
        ctx.actorId,
      )
      await audit(
        ctx,
        "analyze",
        CONVERSATION_ANALYSIS_OBJECT,
        analysis.id,
        // Metadata only: the code, never the message, never the text.
        {
          ...conversationAnalysisAuditPayload(failed ?? analysis),
          outcome: "failed",
          errorCode: code,
        },
      )
      throw new ConversationAnalysisFailedError(code, safeMessage)
    }
  }

  /** Create the `queued` row for one type. Shared by both entry points. */
  async function createRow(
    ctx: ConversationIntelligenceServiceContext,
    source: ConversationSource,
    bounded: BoundedConversationText,
    analysisType: ConversationAnalysisType,
  ): Promise<ConversationAnalysisRecord> {
    return deps.store.createAnalysis(
      ctx.workspaceId,
      {
        subjectType: source.subjectType,
        subjectId: source.subjectId,
        analysisType,
        status: "queued",
        runId: newId(),
        requestedBy: ctx.actorId,
        correlationId: ctx.correlationId ?? null,
        sourceChars: bounded.sourceChars,
        analysedChars: bounded.analysedChars,
        truncated: bounded.truncated,
      },
      ctx.actorId,
    )
  }

  /**
   * Resolve + bound one conversation for a request that names it.
   * Refuses an empty conversation before a single token is spent.
   */
  async function prepare(
    ctx: ConversationIntelligenceServiceContext,
    subjectType: ConversationSubjectType,
    subjectId: string,
  ): Promise<{ source: ConversationSource; bounded: BoundedConversationText }> {
    const source = await loadSubject(ctx, subjectType, subjectId)
    const bounded = boundConversationSource(source, maxSourceChars)
    if (bounded.text.trim() === "") {
      throw new ConversationSourceEmptyError(subjectType, subjectId)
    }
    return { source, bounded }
  }

  /**
   * The on-demand path: a person pressed "analyse" and is waiting.
   * One provider call per requested type, each independently bounded, so
   * the cost of this call is `types.length × the cap` and no more.
   */
  async function analyzeConversation(
    ctx: ConversationIntelligenceServiceContext,
    rawInput: unknown,
  ): Promise<ConversationAnalysisRecord[]> {
    requirePermission(conversationPermission(ctx, "read"))
    const input = requestConversationAnalysisSchema.parse(rawInput)
    const types = input.types.slice(0, maxTypesPerRequest)
    const { source, bounded } = await prepare(ctx, input.subjectType, input.subjectId)

    const out: ConversationAnalysisRecord[] = []
    for (const analysisType of types) {
      const row = await createRow(ctx, source, bounded, analysisType)
      out.push(await runOne(ctx, row, source, bounded, input.model ?? null))
    }
    return out
  }

  /**
   * The queued path. Persists `queued` rows and hands them to the BullMQ
   * seam; nothing is sent to a provider inside this call. The job carries
   * ids and the requester, never text — the worker re-resolves the
   * conversation under the requester's inherited context, so a job that
   * outlives somebody's access to a thread does nothing.
   */
  async function queueConversationAnalysis(
    ctx: ConversationIntelligenceServiceContext,
    rawInput: unknown,
  ): Promise<ConversationAnalysisRecord[]> {
    requirePermission(conversationPermission(ctx, "read"))
    const input = requestConversationAnalysisSchema.parse(rawInput)
    const queue = deps.queue
    if (!queue) throw new ConversationAnalysisQueueUnavailableError()
    const types = input.types.slice(0, maxTypesPerRequest)
    const { source, bounded } = await prepare(ctx, input.subjectType, input.subjectId)

    const out: ConversationAnalysisRecord[] = []
    for (const analysisType of types) {
      const row = await createRow(ctx, source, bounded, analysisType)
      await queue.enqueueConversationAnalysis({
        workspaceId: ctx.workspaceId,
        analysisId: row.id,
        subjectType: source.subjectType,
        subjectId: source.subjectId,
        analysisType,
        actorId: ctx.actorId,
        correlationId: ctx.correlationId ?? null,
      })
      await audit(ctx, "queue", CONVERSATION_ANALYSIS_OBJECT, row.id, {
        ...conversationAnalysisAuditPayload(row),
        outcome: "queued",
      })
      out.push(row)
    }
    return out
  }

  /**
   * What the worker calls, with the requester's inherited context.
   *
   * Idempotent: a row that already reached a terminal status is returned
   * untouched, so a BullMQ retry after a crash between the provider call
   * and the acknowledgement cannot bill for a second analysis. Every gate
   * runs again here — the queue is a transport, not a permission bypass.
   */
  async function runQueuedConversationAnalysis(
    ctx: ConversationIntelligenceServiceContext,
    analysisId: string,
  ): Promise<ConversationAnalysisRecord> {
    requirePermission(conversationPermission(ctx, "read"))
    const { analysis, source } = await loadVisibleAnalysis(ctx, analysisId)
    if (analysis.status !== "queued") return analysis
    const bounded = boundConversationSource(source, maxSourceChars)
    if (bounded.text.trim() === "") {
      throw new ConversationSourceEmptyError(subjectTypeOf(analysis), analysis.subjectId)
    }
    const model = typeof analysis.model === "string" ? analysis.model : null
    return runOne(ctx, analysis, source, bounded, model)
  }

  /* ------------------------------ transcripts --------------------------- */

  /**
   * THE SPEECH-TO-TEXT SEAM (see `transcript.ts`). A transcript arrives as
   * text — from a notetaker/STT payload or a human paste — and is stored
   * against a conversation the caller can already read.
   *
   * Idempotent on `externalId`: a re-delivered webhook returns the
   * existing row instead of creating a duplicate.
   */
  async function ingestCallTranscript(
    ctx: ConversationIntelligenceServiceContext,
    rawInput: unknown,
  ): Promise<{ transcript: CallTranscriptRecord; created: boolean }> {
    requirePermission(conversationPermission(ctx, "create", CALL_TRANSCRIPT_OBJECT))
    const input = ingestCallTranscriptSchema.parse(rawInput)
    // Reading the conversation is required to attach a transcript to it:
    // a transcript is never a way to write into a thread you cannot see.
    await loadSubject(ctx, input.subjectType, input.subjectId)

    if (!blank(input.externalId)) {
      const existing = await deps.store.findTranscriptByExternalId(
        ctx.workspaceId,
        input.externalId as string,
      )
      if (existing) return { transcript: existing, created: false }
    }

    const segments = normalizeCallTranscriptSegments(input.segments ?? [])
    const body = (
      blank(input.text) ? callTranscriptTextFromSegments(segments) : (input.text as string)
    ).slice(0, CALL_TRANSCRIPT_MAX_CHARS)

    const transcript = await deps.store.createTranscript(
      ctx.workspaceId,
      {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        source: callTranscriptSourceSchema.parse(input.source),
        providerId: input.providerId ?? null,
        externalId: input.externalId ?? null,
        language: input.language ?? null,
        text: body,
        segments: segments.length > 0 ? segments : null,
        durationMs: input.durationMs ?? null,
        speakerCount: callTranscriptSpeakers(segments).length,
        charCount: body.length,
      },
      ctx.actorId,
    )

    // Metadata only — never the transcript, not even a snippet.
    await audit(
      ctx,
      "ingest",
      CALL_TRANSCRIPT_OBJECT,
      transcript.id,
      {
        transcriptId: transcript.id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        source: input.source,
        providerId: input.providerId ?? null,
        externalId: input.externalId ?? null,
        language: input.language ?? null,
        charCount: body.length,
        segmentCount: segments.length,
        speakerCount: callTranscriptSpeakers(segments).length,
      },
      input.source === "manual" ? "user" : "integration",
    )
    return { transcript, created: true }
  }

  /* ------------------------------- proposals ---------------------------- */

  /**
   * Propose ONE extracted action item as a task — property 2.
   *
   * This is the entire path from an AI-extracted item to a CRM record, and
   * it does not write one. It hands the proposal to spec 38's
   * `requestAction()`, which resolves the requester's LIVE role, applies
   * the workspace's AI policy, and (under the default `require_approval`
   * mode) parks it as `pending` for a human. The task is created by the
   * governance module's applier when somebody approves, through the Tasks
   * module's own service — never from here.
   *
   * The proposal's `after` block carries the item's title, because a
   * reviewer cannot approve a change they cannot see. THIS MODULE'S audit
   * row carries only the index — the reviewable copy lives in the
   * governance request, whose whole purpose is to be read by a human.
   */
  async function proposeConversationActionItem(
    ctx: ConversationIntelligenceServiceContext,
    analysisId: string,
    rawInput: unknown,
  ): Promise<AiActionRequestOutcome> {
    requirePermission(conversationPermission(ctx, "read"))
    const input = proposeConversationActionItemSchema.parse(rawInput)
    const governance = deps.governance
    if (!governance) throw new ConversationGovernanceUnavailableError()

    const { analysis } = await loadVisibleAnalysis(ctx, analysisId)
    const items = conversationActionItemsOf(analysis.output)
    const item: ConversationActionItem | undefined = items[input.itemIndex]
    if (!item) throw new ConversationActionItemNotFoundError(input.itemIndex)

    const outcome = await governance.requestAction(
      { ...ctx, actorType: "agent", agentId: CONVERSATION_INTELLIGENCE_AGENT_ID },
      {
        objectType: CONVERSATION_ACTION_ITEM_OBJECT_TYPE,
        action: "create",
        after: {
          title: item.title,
          assigneeId: input.assigneeId ?? null,
          dueDate: input.dueDate ?? item.dueDate,
          sourceSubjectType: analysis.subjectType,
          sourceSubjectId: analysis.subjectId,
          sourceAnalysisId: analysis.id,
        },
        rationale: `Extracted from the ${String(analysis.analysisType)} of ${String(analysis.subjectType)} ${String(analysis.subjectId)}. Nothing is created until this is approved.`,
        model: analysis.model ?? null,
        runId: analysis.runId ?? null,
        agentId: CONVERSATION_INTELLIGENCE_AGENT_ID,
      },
    )

    await audit(ctx, "propose_action_item", CONVERSATION_ANALYSIS_OBJECT, analysis.id, {
      ...conversationAnalysisAuditPayload(analysis),
      // The index, not the title: the reviewable copy is the governance
      // request. Property 4.
      itemIndex: input.itemIndex,
      itemCount: items.length,
      requestId: outcome.request.id,
      requestStatus: outcome.request.status,
      policyMode: outcome.mode,
      applied: outcome.applied,
    })
    return outcome
  }

  /** The extracted items of one analysis, as data. Never a write. */
  async function listActionItems(
    ctx: ConversationIntelligenceServiceContext,
    analysisId: string,
  ): Promise<ConversationActionItem[]> {
    requirePermission(conversationPermission(ctx, "read"))
    const { analysis } = await loadVisibleAnalysis(ctx, analysisId)
    return conversationActionItemsOf(analysis.output)
  }

  return {
    listAnalyses,
    getAnalysis,
    listAnalysesForSubject,
    listTranscripts,
    listActionItems,
    describeStatus,
    analyzeConversation,
    queueConversationAnalysis,
    runQueuedConversationAnalysis,
    ingestCallTranscript,
    proposeConversationActionItem,
  }
}

export type ConversationIntelligenceService = ReturnType<
  typeof createConversationIntelligenceService
>
