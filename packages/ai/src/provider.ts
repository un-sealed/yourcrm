/**
 * `AiProvider` — the LLM provider port every AI feature in YourCRM is built
 * on (spec 34-ai-assistant, P0).
 *
 * ONE PORT, MANY BACKENDS
 * -----------------------
 * A provider is any object that can turn a message list into text plus token
 * usage. Nothing above this line knows whether the bytes came from an
 * OpenAI-compatible HTTP endpoint, a local Ollama, or the deterministic stub
 * the tests run on. Downstream agents (AI agents, conversation intelligence,
 * MCP) depend on THIS type and receive an instance by injection — they never
 * construct one, never read `AI_API_KEY`, and never call `fetch` themselves.
 *
 * DESIGN RULES BAKED INTO THE SHAPE
 * ---------------------------------
 *  1. **Usage is not optional.** Every call returns {@link AiUsage} and
 *     `latencyMs`, because every call must be recordable in `ai_runs` with a
 *     cost. A provider that cannot report usage reports zeros, never `null` —
 *     callers should not branch on accounting.
 *  2. **Attribution travels with the answer.** `model` and `providerId` come
 *     back on the completion (not just from config), so a stored message can
 *     always name the model that produced it even after the workspace
 *     switches models mid-conversation.
 *  3. **Tools are described, never executed, here.** `completeWithTools`
 *     returns the calls the model *wants*; running them — under the caller's
 *     permissions — is the assistant service's job. A provider never touches
 *     CRM data.
 *  4. **No secret ever reaches an error.** Implementations must run every
 *     message they raise through a redactor before it becomes an
 *     {@link AiProviderError} (see `redactIntegrationSecrets` in
 *     `@yourcrm/crm/src/integrations`).
 *  5. **Streaming is a P1 extension, not a second port.** It arrives as an
 *     optional `streamComplete()` member on this same type so that existing
 *     implementations stay valid.
 *
 * WHERE THE IMPLEMENTATIONS LIVE (read before "fixing" this)
 * ----------------------------------------------------------
 * `packages/ai` is not yet a declared dependency of `apps/api`,
 * `apps/worker`, `apps/mcp` or `packages/crm`, so `import "@yourcrm/ai"`
 * does not resolve from any of them (bun symlinks only declared
 * dependencies — verified, and the same gap `packages/crm/src/integrations`
 * documents for `@yourcrm/integrations`). Editing `package.json` is outside
 * an agent's scope, so it is reported as a blocker instead.
 *
 * Until that dependency is declared, the shipping implementations live in
 * `packages/crm/src/ai-assistant/providers/` against a byte-identical
 * structural mirror of this port (`AiProviderPort`). When the dependency
 * lands, the move is mechanical:
 *
 * ```ts
 * // packages/crm/src/ai-assistant/types.ts
 * import type { AiProvider } from "@yourcrm/ai"
 * export type AiProviderPort = AiProvider
 * ```
 *
 * and the provider files move here unchanged.
 */

/** Conversation roles the port accepts. Mirrors the OpenAI chat contract. */
export type AiMessageRole = "system" | "user" | "assistant" | "tool"

/**
 * One tool invocation requested by the model. `arguments` is already parsed
 * JSON: providers own the wire format, callers never re-parse strings.
 */
export type AiToolCall = {
  /** Provider-assigned id. Echoed back on the matching tool result message. */
  id: string
  name: string
  arguments: Record<string, unknown>
}

/**
 * A message in provider form. Deliberately *not* the `ai_messages` row shape:
 * persistence belongs to the assistant service, which maps between the two.
 */
export type AiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: readonly AiToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string }

/**
 * A tool offered to the model. `parameters` is a JSON Schema object — the
 * lingua franca of every tool-calling API and of the MCP SDK, so the same
 * definition can be exposed over MCP without translation.
 */
export type AiToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Token accounting for one call. Always present; zeros when unreported. */
export type AiUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type AiFinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "unknown"

export type AiCompleteOptions = {
  /** Overrides the provider's default model for this call only. */
  model?: string
  temperature?: number
  maxOutputTokens?: number
  /** Caller-owned cancellation, composed with the provider's own timeout. */
  signal?: AbortSignal
  /** Request id, for provider-side log correlation. Never a secret. */
  correlationId?: string
}

/** The single return shape of both port methods. */
export type AiCompletion = {
  /** Assistant text. Empty string when the model only asked for tools. */
  text: string
  /** Tools the model wants run. Always an array — empty when none. */
  toolCalls: AiToolCall[]
  finishReason: AiFinishReason
  /** The model that actually answered (attribution, spec 34 §14). */
  model: string
  /** Provider that answered, e.g. `openai-compatible` or `stub`. */
  providerId: string
  usage: AiUsage
  /** Wall-clock duration measured by the provider, for `ai_runs.latency_ms`. */
  latencyMs: number
}

/**
 * The port. Two methods, both returning {@link AiCompletion}:
 *
 * ```ts
 * const answer = await provider.complete([{ role: "user", content: "hi" }])
 * const step = await provider.completeWithTools(messages, tools, { model })
 * ```
 */
export type AiProvider = {
  /** Stable identifier, recorded on every `ai_runs` row. */
  readonly id: string
  /** Model used when `opts.model` is omitted. Recorded for attribution. */
  readonly defaultModel: string
  complete(messages: readonly AiMessage[], opts?: AiCompleteOptions): Promise<AiCompletion>
  completeWithTools(
    messages: readonly AiMessage[],
    tools: readonly AiToolDefinition[],
    opts?: AiCompleteOptions,
  ): Promise<AiCompletion>
}

/** Failure taxonomy callers can branch on without parsing messages. */
export const AI_PROVIDER_ERROR_CODES = [
  "AI_PROVIDER_UNAVAILABLE",
  "AI_PROVIDER_TIMEOUT",
  "AI_PROVIDER_UNAUTHORIZED",
  "AI_PROVIDER_RATE_LIMITED",
  "AI_PROVIDER_INVALID_RESPONSE",
  "AI_PROVIDER_NOT_CONFIGURED",
] as const

export type AiProviderErrorCode = (typeof AI_PROVIDER_ERROR_CODES)[number]

/**
 * Provider failure. The message must already be redacted by the thrower —
 * this class does no redaction of its own, so that there is exactly one
 * place (the provider) responsible for never letting a key escape.
 */
export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode
  /** HTTP status when the failure came from a response. */
  readonly status: number | null
  /** True when a retry could plausibly succeed. */
  readonly retryable: boolean

  constructor(
    code: AiProviderErrorCode,
    message: string,
    options: { status?: number | null; retryable?: boolean } = {},
  ) {
    super(message)
    this.name = "AiProviderError"
    this.code = code
    this.status = options.status ?? null
    this.retryable = options.retryable ?? false
  }
}

/** Zero usage. Use instead of `null` so accounting is always additive. */
export function emptyAiUsage(): AiUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
}

/** Fold usage across the steps of one multi-turn tool loop. */
export function sumAiUsage(parts: readonly AiUsage[]): AiUsage {
  return parts.reduce<AiUsage>(
    (acc, part) => ({
      promptTokens: acc.promptTokens + part.promptTokens,
      completionTokens: acc.completionTokens + part.completionTokens,
      totalTokens: acc.totalTokens + part.totalTokens,
    }),
    emptyAiUsage(),
  )
}
