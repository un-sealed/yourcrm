import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"
import type {
  ReportExecutionRequest,
  ReportExecutionResult,
  ReportObjectCatalogEntry,
  ReportRowScope,
} from "../reports/types"

/**
 * Ask-Your-CRM assistant ports (spec 34-ai-assistant, P0).
 *
 * ## The mirrored provider contract — read this first
 *
 * `AiProviderPort` below is a STRUCTURAL MIRROR of `AiProvider` in
 * `packages/ai/src/provider.ts`. It is not a second provider model: it is
 * the same model, restated so this package can reference it.
 *
 * Why: bun workspaces symlink only *declared* dependencies, and neither
 * `packages/crm/package.json` nor `apps/api/package.json` declares
 * `@yourcrm/ai`, so `import ... from "@yourcrm/ai"` does not resolve here
 * (verified). Editing package.json is outside this agent's scope, so the
 * gap is reported as a blocker to the integrator. This is exactly the
 * pattern `../integrations/types.ts` already uses for
 * `IntegrationProviderPort`.
 *
 * When the dependency is wired, this whole block collapses to:
 *
 * ```ts
 * import type { AiProvider } from "@yourcrm/ai"
 * export type AiProviderPort = AiProvider
 * ```
 *
 * the two provider implementations in `./providers/` move to
 * `packages/ai/src/`, and nothing else in this module changes — the shapes
 * are identical today.
 *
 * ## Everything else here is a store port
 *
 * `@yourcrm/crm` has no database dependency, so the service talks to the
 * structural stores below. `apps/api` adapts
 * `@yourcrm/database/src/repositories/ai-repository` to them; tests satisfy
 * them with in-memory fakes.
 *
 * ## Naming
 *
 * One generated `export *` barrel covers every CRM module, so every name
 * here carries the `Ai` prefix. `Message`, `Run`, `Provider` and `Tool`
 * would collide on sight.
 */

/* ----------------------------- provider ------------------------------ */

/** Mirror of `AiToolCall`. Arguments arrive parsed, never as a JSON string. */
export type AiProviderToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** Mirror of `AiMessage` — provider wire form, not the `ai_messages` row. */
export type AiProviderMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: readonly AiProviderToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string }

/** Mirror of `AiToolDefinition`. `parameters` is a JSON Schema object. */
export type AiProviderToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Mirror of `AiUsage`. Always present; zeros when the provider is silent. */
export type AiTokenUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type AiFinishReasonValue = "stop" | "length" | "tool_calls" | "content_filter" | "unknown"

/** Mirror of `AiCompleteOptions`. */
export type AiCompleteOptions = {
  model?: string
  temperature?: number
  maxOutputTokens?: number
  signal?: AbortSignal
  correlationId?: string
}

/** Mirror of `AiCompletion`. */
export type AiCompletionResult = {
  text: string
  toolCalls: AiProviderToolCall[]
  finishReason: AiFinishReasonValue
  model: string
  providerId: string
  usage: AiTokenUsage
  latencyMs: number
}

/** Structural mirror of `AiProvider` — see the header. */
export type AiProviderPort = {
  readonly id: string
  readonly defaultModel: string
  complete(
    messages: readonly AiProviderMessage[],
    opts?: AiCompleteOptions,
  ): Promise<AiCompletionResult>
  completeWithTools(
    messages: readonly AiProviderMessage[],
    tools: readonly AiProviderToolDefinition[],
    opts?: AiCompleteOptions,
  ): Promise<AiCompletionResult>
}

/* ------------------------------- tools -------------------------------- */

/** Tool calls run as the asking user. Same context the service received. */
export type AiToolContext = ServiceContext

/** What a tool hands back: a JSON payload for the model plus a UI summary. */
export type AiToolExecution = {
  result: unknown
  /** One line for the tool-call transparency panel. Never contains secrets. */
  summary: string
}

/**
 * A tool the assistant may call.
 *
 * `access` is the P0 safety seam. Only `"read"` tools exist today and
 * `createAiToolRegistry` refuses anything else, so a write cannot reach the
 * model by accident while spec 38's approval queue is still being built.
 * When it lands, a `"write"` tool will be admissible only through that
 * queue — it must request approval instead of mutating, and the registry
 * gate is where that policy is enforced.
 */
export type AiTool = {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly access: "read"
  execute(ctx: AiToolContext, args: Record<string, unknown>): Promise<AiToolExecution>
}

export type AiToolRegistry = {
  list(): AiTool[]
  get(name: string): AiTool | null
  /** Definitions in provider form, ready for `completeWithTools`. */
  definitions(): AiProviderToolDefinition[]
}

/**
 * Read side of the reporting engine, as the query tool needs it.
 * `ReportsStore` from `../reports/types` satisfies this exactly, so the
 * composition root passes the very same store the reports module uses —
 * the assistant never builds SQL and never sees a table.
 */
export type AiReportQueryPort = {
  describeObjects(): ReportObjectCatalogEntry[]
  execute(
    workspaceId: string,
    request: ReportExecutionRequest,
    scope: ReportRowScope,
  ): Promise<ReportExecutionResult>
}

/* ------------------------------- stores -------------------------------- */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type AiConversationRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  title: string
}

/**
 * `role` and `outcome` are plain strings on the *record* types: rows come
 * back from drizzle as `varchar`, and narrowing them here would force a
 * cast at every repository adapter. The allowlists below are enforced
 * where it matters — on the way in (`AiMessageInsert`, `AiRunInsert`, the
 * repository validators and the CHECK constraints).
 */
export type AiMessageRecord = Record<string, unknown> & {
  id: string
  conversationId: string
  role: string
  content: string
}

export type AiRunRecord = Record<string, unknown> & {
  id: string
  conversationId: string
  model: string
  outcome: string
}

export const AI_MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const

export type AiMessageRoleValue = (typeof AI_MESSAGE_ROLES)[number]

export const AI_RUN_OUTCOMES = ["succeeded", "failed", "denied"] as const

export type AiRunOutcomeValue = (typeof AI_RUN_OUTCOMES)[number]

export type AiConversationListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
}

export type AiConversationListResult = {
  data: AiConversationRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

/** A conversation is personal: only its owner may read it. See `access.ts`. */
export type AiConversationScope = { kind: "own"; actorId: string }

export type AiMessageInsert = {
  conversationId: string
  role: AiMessageRoleValue
  content: string
  /** Set on assistant rows: which model produced this text (spec 34 §14). */
  model?: string | null
  providerId?: string | null
  /** Ties the row to its `ai_runs` row, so every token is attributable. */
  runId?: string | null
  /** Tool calls the assistant asked for, or the result of one. */
  toolCalls?: unknown
  /** Provider tool-call id echoed on a `tool` row. */
  toolCallId?: string | null
  toolName?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  actorId?: string | null
}

export type AiRunInsert = {
  /** Generated by the service so messages and audit rows can reference it. */
  id: string
  conversationId: string
  messageId?: string | null
  providerId: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs: number
  /** Micro-USD (1e-6 USD). Null when the model has no configured price. */
  costMicros: number | null
  outcome: AiRunOutcomeValue
  /** Provider error code, never a message that could carry a credential. */
  errorCode?: string | null
  errorMessage?: string | null
  toolCallCount: number
  /** One entry per tool invocation: name, outcome, duration. No payloads. */
  toolCalls?: unknown
  correlationId?: string | null
  actorId?: string | null
}

export type AiAssistantStore = {
  listConversations(
    workspaceId: string,
    query: AiConversationListQuery,
    scope: AiConversationScope,
  ): Promise<AiConversationListResult>
  findConversation(workspaceId: string, id: string): Promise<AiConversationRecord | null>
  createConversation(
    workspaceId: string,
    input: { title: string; model?: string | null },
    actorId?: string,
  ): Promise<AiConversationRecord>
  updateConversation(
    workspaceId: string,
    id: string,
    patch: { title?: string; model?: string | null; lastMessageAt?: Date },
    actorId?: string,
  ): Promise<AiConversationRecord | null>
  softDeleteConversation(workspaceId: string, id: string, actorId?: string): Promise<void>
  listMessages(
    workspaceId: string,
    conversationId: string,
    limit?: number,
  ): Promise<AiMessageRecord[]>
  appendMessage(
    workspaceId: string,
    input: AiMessageInsert,
    actorId?: string,
  ): Promise<AiMessageRecord>
  recordRun(workspaceId: string, input: AiRunInsert, actorId?: string): Promise<AiRunRecord>
  listRuns(workspaceId: string, conversationId: string, limit?: number): Promise<AiRunRecord[]>
}

/* ------------------------------ service -------------------------------- */

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type AiAuditInput = {
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

/** Micro-USD per one million tokens, per model. Absent model ⇒ cost null. */
export type AiModelPrice = { inputMicrosPerMillion: number; outputMicrosPerMillion: number }

export type AiModelPricingTable = Record<string, AiModelPrice>

export type AiAssistantServiceContext = ServiceContext

export type AiAssistantServiceDeps = {
  store: AiAssistantStore
  provider: AiProviderPort
  tools: AiToolRegistry
  audit: AuditWriter<AiAuditInput>
  events?: EventEmitter
  pricing?: AiModelPricingTable
  /** Provider round-trips per question, tool steps included. Default 4. */
  maxToolIterations?: number
  /** History turns replayed to the model. Default 20. */
  historyLimit?: number
  /** Extra guidance appended to the system prompt (workspace tone, etc). */
  systemPromptSuffix?: string
  /** Injectable clock — hermetic tests assert exact timestamps. */
  now?: () => Date
  /** Injectable id source — hermetic tests assert exact run ids. */
  newId?: () => string
}

/** One tool invocation as reported back to the caller and the audit log. */
export type AiToolCallReport = {
  id: string
  name: string
  arguments: Record<string, unknown>
  outcome: "succeeded" | "failed" | "denied"
  summary: string
  durationMs: number
}

/** What `ask()` returns: the answer plus everything needed to attribute it. */
export type AiAskResult = {
  conversation: AiConversationRecord
  userMessage: AiMessageRecord
  assistantMessage: AiMessageRecord
  run: AiRunRecord
  toolCalls: AiToolCallReport[]
}

/** Non-secret provider description handed to the UI for attribution. */
export type AiProviderStatus = {
  providerId: string
  model: string
  tools: { name: string; description: string }[]
}

export type AiConversationDetail = {
  conversation: AiConversationRecord
  messages: AiMessageRecord[]
  runs: AiRunRecord[]
}
