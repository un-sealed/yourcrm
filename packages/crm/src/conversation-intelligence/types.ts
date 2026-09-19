import type { AiProvider } from "@yourcrm/ai"
import type { AiActionProposalPort } from "../ai-governance/types"
import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Conversation-intelligence ports (spec 37, P0).
 *
 * ## The provider is the shared port, not a copy
 *
 * `@yourcrm/ai` IS a declared dependency of `packages/crm` on this branch,
 * so this module imports {@link AiProvider} directly instead of restating
 * it the way `../ai-assistant/types.ts` had to before the dependency
 * landed. There is one provider model in the product; this module adds no
 * second one and constructs no provider of its own — it receives one.
 *
 * ## The conversations are somebody else's
 *
 * A summary of an email thread is not an email feature and an email thread
 * is not a conversation-intelligence record. The subject of an analysis is
 * named by a `(subjectType, subjectId)` pair and is resolved through
 * {@link ConversationSourcePort} — an adapter over the OWNING module's
 * domain service, run under the caller's own `ServiceContext`.
 *
 * That indirection is the whole permission story:
 *
 *  - the owning service runs its own `requirePermission()` and its own
 *    record-level visibility rules, so this module cannot see a
 *    conversation the caller could not open by hand;
 *  - a subject that is missing and a subject that is hidden come back the
 *    same way (`null`), so an analysis request cannot be used to probe for
 *    the existence of a thread;
 *  - an ANALYSIS inherits that answer on every read. Nothing about the
 *    subject's visibility is copied into this module's tables, so nothing
 *    can go stale.
 *
 * Email lives in `../email`, Calling in `../calling` and WhatsApp in
 * `../whatsapp`; the API composition root adapts whichever of them a
 * deployment has. A module that is absent simply has no source registered
 * and its subject type is unanalysable — never silently readable.
 *
 * ## Writes go through governance, never from here
 *
 * {@link ConversationIntelligenceServiceDeps.governance} is the real
 * {@link AiActionProposalPort} from `../ai-governance`. An extracted
 * action item is DATA until a human approves a proposal; this module has
 * no path that writes a task, a note or a field on another module's
 * record. See `service.ts`.
 */

/* ------------------------------ vocabulary ----------------------------- */

/**
 * Kinds of conversation this module can read. Mirrors
 * `CONVERSATION_SUBJECT_TYPE_VALUES` in
 * `@yourcrm/database/src/schema/conversation-intelligence` — deliberately
 * re-declared rather than imported, because the domain layer must not
 * depend on the database package (`docs/architecture.md`). Named
 * `…_NAMES` so importing both packages in one file stays unambiguous.
 */
export const CONVERSATION_SUBJECT_TYPE_NAMES = [
  "email_thread",
  "whatsapp_conversation",
  "call",
] as const

export type ConversationSubjectType = (typeof CONVERSATION_SUBJECT_TYPE_NAMES)[number]

export function isConversationSubjectTypeName(value: unknown): value is ConversationSubjectType {
  return (
    typeof value === "string" &&
    (CONVERSATION_SUBJECT_TYPE_NAMES as readonly string[]).includes(value)
  )
}

/**
 * The four P0 analyses. Each is one provider call producing one row, so
 * the token cost of a request is exactly `types.length × the cap` and
 * every row's token count is its own, never a share of a pooled total.
 */
export const CONVERSATION_ANALYSIS_TYPE_NAMES = [
  "summary",
  "sentiment",
  "action_items",
  "key_topics",
] as const

export type ConversationAnalysisType = (typeof CONVERSATION_ANALYSIS_TYPE_NAMES)[number]

export const CONVERSATION_ANALYSIS_STATUS_NAMES = ["queued", "succeeded", "failed"] as const

export type ConversationAnalysisStatus = (typeof CONVERSATION_ANALYSIS_STATUS_NAMES)[number]

export const CALL_TRANSCRIPT_SOURCE_NAMES = ["provider", "manual"] as const

export type CallTranscriptSource = (typeof CALL_TRANSCRIPT_SOURCE_NAMES)[number]

/* -------------------------------- records ------------------------------ */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type ConversationAnalysisRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  subjectType: string
  subjectId: string
  analysisType: string
  status: string
}

export type CallTranscriptRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  subjectType: string
  subjectId: string
  text: string
}

export type ConversationAnalysisListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  subjectType?: ConversationSubjectType
  subjectId?: string
  analysisType?: ConversationAnalysisType
  status?: ConversationAnalysisStatus
}

export type ConversationAnalysisListResult = {
  data: ConversationAnalysisRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

/* ------------------------------- the source ---------------------------- */

/** One turn of a conversation, normalised across channels. */
export type ConversationTurn = {
  /** Display name of the speaker/sender. Never an internal id. */
  speaker: string
  /** ISO-8601 instant, or null when the channel does not record one. */
  at: string | null
  /** Plain text. HTML has already been flattened by the owning module. */
  text: string
}

/**
 * A conversation as this module needs it: who said what, in order. The
 * adapter produces this from the owning module's detail record; nothing
 * here is stored — it is built per analysis and discarded.
 */
export type ConversationSource = {
  subjectType: ConversationSubjectType
  subjectId: string
  /** Human title for the detail header (thread subject, call summary, …). */
  title: string
  turns: ConversationTurn[]
  participants: string[]
  /** When the conversation happened/started. ISO-8601 or null. */
  occurredAt: string | null
}

/**
 * Adapter over ONE owning module's read path.
 *
 * `load` MUST call the owning module's domain service with the caller's
 * context, and MUST return `null` both when the subject does not exist and
 * when the caller may not read it — an analysis request must never be a
 * probe for the existence of a thread.
 *
 * `filterReadable` answers the same question in bulk for a list page. An
 * implementation may simply call `load` per id; a real one should use the
 * owning module's list query so a page costs one round trip.
 */
export type ConversationSourcePort = {
  readonly subjectType: ConversationSubjectType
  load(ctx: ServiceContext, subjectId: string): Promise<ConversationSource | null>
  filterReadable(ctx: ServiceContext, subjectIds: readonly string[]): Promise<string[]>
}

export type ConversationSourceRegistry = {
  get(subjectType: ConversationSubjectType): ConversationSourcePort | null
  /** Subject types this deployment can analyse at all. */
  subjectTypes(): ConversationSubjectType[]
}

/* -------------------------------- stores ------------------------------- */

export type ConversationAnalysisInsert = {
  subjectType: ConversationSubjectType
  subjectId: string
  analysisType: ConversationAnalysisType
  status: ConversationAnalysisStatus
  runId: string
  requestedBy?: string | null
  correlationId?: string | null
  sourceChars: number
  analysedChars: number
  truncated: boolean
}

export type ConversationAnalysisPatch = {
  status?: ConversationAnalysisStatus
  providerId?: string | null
  model?: string | null
  output?: unknown
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  latencyMs?: number
  analysedAt?: Date | null
  errorCode?: string | null
  /** Already redacted of source text by the service. */
  errorMessage?: string | null
}

export type CallTranscriptInsert = {
  subjectType: ConversationSubjectType
  subjectId: string
  source: CallTranscriptSource
  providerId?: string | null
  externalId?: string | null
  language?: string | null
  text: string
  segments?: unknown
  durationMs?: number | null
  speakerCount: number
  charCount: number
}

/**
 * Persistence port. `@yourcrm/crm` has no database dependency, so the
 * service talks to this shape; `apps/api` adapts
 * `conversation-intelligence-repository.ts` and the hermetic tests satisfy
 * it with in-memory fakes.
 *
 * `listAnalyses` takes the readable subject types as a REQUIRED argument
 * so "every analysis in the workspace" cannot happen by forgetting a
 * filter — the same contract `InboxStore.list` uses for channels.
 */
export type ConversationIntelligenceStore = {
  listAnalyses(
    workspaceId: string,
    query: ConversationAnalysisListQuery,
    subjectTypes: readonly ConversationSubjectType[],
  ): Promise<ConversationAnalysisListResult>
  findAnalysis(workspaceId: string, id: string): Promise<ConversationAnalysisRecord | null>
  createAnalysis(
    workspaceId: string,
    input: ConversationAnalysisInsert,
    actorId?: string,
  ): Promise<ConversationAnalysisRecord>
  updateAnalysis(
    workspaceId: string,
    id: string,
    patch: ConversationAnalysisPatch,
    actorId?: string,
  ): Promise<ConversationAnalysisRecord | null>
  listTranscripts(
    workspaceId: string,
    subjectType: ConversationSubjectType,
    subjectId: string,
    limit?: number,
  ): Promise<CallTranscriptRecord[]>
  findTranscript(workspaceId: string, id: string): Promise<CallTranscriptRecord | null>
  /** Idempotency probe for provider re-delivery. */
  findTranscriptByExternalId(
    workspaceId: string,
    externalId: string,
  ): Promise<CallTranscriptRecord | null>
  createTranscript(
    workspaceId: string,
    input: CallTranscriptInsert,
    actorId?: string,
  ): Promise<CallTranscriptRecord>
}

/* --------------------------------- queue -------------------------------- */

/** What the worker is handed. Carries ids and a role, never text. */
export type ConversationAnalysisJob = {
  workspaceId: string
  analysisId: string
  subjectType: ConversationSubjectType
  subjectId: string
  analysisType: ConversationAnalysisType
  /** The requester, whose permissions the worker re-resolves and inherits. */
  actorId: string
  correlationId?: string | null
}

/**
 * The BullMQ seam (`apps/worker/src/queues.ts`). Domain code never imports
 * BullMQ; it enqueues through this port, and the API composition root
 * binds it. Analysis is on-demand or queued — never inline in a request.
 */
export type ConversationAnalysisQueuePort = {
  enqueueConversationAnalysis(job: ConversationAnalysisJob): Promise<void>
}

/* --------------------------------- service ------------------------------ */

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type ConversationIntelligenceAuditInput = {
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

export type ConversationIntelligenceServiceContext = ServiceContext

export type ConversationIntelligenceServiceDeps = {
  store: ConversationIntelligenceStore
  sources: ConversationSourceRegistry
  /** Injected, never constructed here. See the header. */
  provider: AiProvider
  audit: AuditWriter<ConversationIntelligenceAuditInput>
  events?: EventEmitter
  /**
   * The ONLY way an output of this module can reach a CRM record. Absent
   * ⇒ `proposeActionItem` refuses; it never falls back to writing.
   */
  governance?: AiActionProposalPort
  /** Absent ⇒ `queueAnalysis` refuses rather than running inline. */
  queue?: ConversationAnalysisQueuePort
  /** Characters of conversation text sent to the provider. See `bounds.ts`. */
  maxSourceChars?: number
  /** Output ceiling passed to the provider on every call. */
  maxOutputTokens?: number
  /** Analyses one request may ask for at once. Default 4. */
  maxTypesPerRequest?: number
  /** Injectable clock — hermetic tests assert exact timestamps. */
  now?: () => Date
  /** Injectable id source — hermetic tests assert exact run ids. */
  newId?: () => string
}

/* --------------------------------- results ------------------------------ */

/** The source conversation as the detail view shows it, with its bounds. */
export type ConversationAnalysisSubject = {
  subjectType: ConversationSubjectType
  subjectId: string
  title: string
  participants: string[]
  occurredAt: string | null
  turns: ConversationTurn[]
  /** Characters in the full conversation. */
  sourceChars: number
  /** Characters that would be sent to the provider. */
  analysedChars: number
  truncated: boolean
}

export type ConversationAnalysisDetail = {
  analysis: ConversationAnalysisRecord
  /** Null when the subject became unreadable — the row is then withheld. */
  subject: ConversationAnalysisSubject | null
}

/** One extracted action item. DATA — never an auto-created task. */
export type ConversationActionItem = {
  title: string
  owner: string | null
  dueDate: string | null
}
