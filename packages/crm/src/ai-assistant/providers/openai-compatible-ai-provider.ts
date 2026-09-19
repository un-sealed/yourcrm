import { redactIntegrationSecrets } from "../../integrations/service"
import type {
  AiCompleteOptions,
  AiCompletionResult,
  AiFinishReasonValue,
  AiProviderMessage,
  AiProviderPort,
  AiProviderToolCall,
  AiProviderToolDefinition,
  AiTokenUsage,
} from "../types"

/**
 * OpenAI-compatible HTTP provider — `POST {baseUrl}/chat/completions`.
 *
 * Plain `fetch`, no SDK: the wire format is stable and shared by OpenAI,
 * OpenRouter, agentrouter, vLLM, Ollama and llama.cpp, so one small client
 * covers every backend YourCRM claims to support (spec 34 §3: BYO
 * provider, local models).
 *
 * ## The User-Agent is not optional
 *
 * Some gateways authorise on the client identity as well as the key and
 * answer `unauthorized client detected` when it is missing or unknown
 * (confirmed empirically against agentrouter). `userAgent` is therefore a
 * **required** config field and is sent on every request. Do not "clean it
 * up" into an optional.
 *
 * ## Secrets
 *
 * The key exists in exactly two places: the `authorization` header, and the
 * redaction list. Every error this file raises — including the body of a
 * provider error response, which gateways sometimes echo credentials into
 * — goes through `redactIntegrationSecrets` before it becomes a message.
 * Nothing here logs, and no caller ever receives the key back.
 *
 * ## Failure handling
 *
 * One bounded retry, only for failures a retry could fix (network drop,
 * timeout, 408, 429, 5xx). Authorisation and validation failures fail fast.
 * The per-attempt deadline is `timeoutMs`; a caller `AbortSignal` cancels
 * the whole call including the pending retry.
 */

export const OPENAI_COMPATIBLE_AI_PROVIDER_ID = "openai-compatible"

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_RETRIES = 1
const DEFAULT_RETRY_DELAY_MS = 400

/**
 * Mirror of `AiProviderErrorCode` in `packages/ai/src/provider.ts`, for the
 * same reason `AiProviderPort` is mirrored — see `../types.ts`.
 */
export const AI_PROVIDER_ERROR_CODE_VALUES = [
  "AI_PROVIDER_UNAVAILABLE",
  "AI_PROVIDER_TIMEOUT",
  "AI_PROVIDER_UNAUTHORIZED",
  "AI_PROVIDER_RATE_LIMITED",
  "AI_PROVIDER_INVALID_RESPONSE",
  "AI_PROVIDER_NOT_CONFIGURED",
] as const

export type AiProviderErrorCodeValue = (typeof AI_PROVIDER_ERROR_CODE_VALUES)[number]

/** Provider failure. The message is redacted before it gets here. */
export class AiProviderRequestError extends Error {
  readonly code: AiProviderErrorCodeValue
  readonly status: number | null
  readonly retryable: boolean

  constructor(
    code: AiProviderErrorCodeValue,
    message: string,
    options: { status?: number | null; retryable?: boolean } = {},
  ) {
    super(message)
    this.name = "AiProviderRequestError"
    this.code = code
    this.status = options.status ?? null
    this.retryable = options.retryable ?? false
  }
}

export type OpenAiCompatibleAiProviderConfig = {
  /** Root of the OpenAI-compatible API, e.g. `https://api.openai.com/v1`. */
  baseUrl: string
  /** Bearer credential. Never logged, never returned, never audited. */
  apiKey: string
  /** Model used when the caller does not override it. */
  model: string
  /** Sent on every request — see the header. Required on purpose. */
  userAgent: string
  timeoutMs?: number
  /** Retries *after* the first attempt. Default 1, i.e. two attempts. */
  maxRetries?: number
  retryDelayMs?: number
  temperature?: number
  maxOutputTokens?: number
  /** Injectable transport. Tests pass a fake; production uses global fetch. */
  fetch?: typeof globalThis.fetch
  /** Overrides the recorded provider id (multi-gateway deployments). */
  id?: string
}

/* ---------------------------- wire mapping ---------------------------- */

type WireToolCall = {
  id?: unknown
  type?: unknown
  function?: { name?: unknown; arguments?: unknown }
}

function toWireMessage(message: AiProviderMessage): Record<string, unknown> {
  if (message.role === "assistant") {
    const toolCalls = message.toolCalls ?? []
    if (toolCalls.length === 0) return { role: "assistant", content: message.content }
    return {
      role: "assistant",
      content: message.content === "" ? null : message.content,
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    }
  }
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content }
  }
  return { role: message.role, content: message.content }
}

function toWireTool(tool: AiProviderToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim() === "") return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    // A model that emits invalid JSON gets an empty argument object, which
    // the tool's zod schema then rejects with a message it can learn from.
    return {}
  }
}

function readToolCalls(value: unknown): AiProviderToolCall[] {
  if (!Array.isArray(value)) return []
  const calls: AiProviderToolCall[] = []
  value.forEach((entry, index) => {
    const call = entry as WireToolCall
    const name = call.function?.name
    if (typeof name !== "string" || name === "") return
    calls.push({
      id: typeof call.id === "string" && call.id !== "" ? call.id : `call_${String(index)}`,
      name,
      arguments: parseToolArguments(call.function?.arguments),
    })
  })
  return calls
}

function readUsage(value: unknown): AiTokenUsage {
  const usage = (value ?? {}) as Record<string, unknown>
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0
  const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0
  const total = typeof usage.total_tokens === "number" ? usage.total_tokens : prompt + completion
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total }
}

const FINISH_REASONS: Record<string, AiFinishReasonValue> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_calls",
  function_call: "tool_calls",
  content_filter: "content_filter",
}

function readFinishReason(value: unknown): AiFinishReasonValue {
  return typeof value === "string" ? (FINISH_REASONS[value] ?? "unknown") : "unknown"
}

/* ------------------------------ provider ------------------------------ */

export function createOpenAiCompatibleAiProvider(
  config: OpenAiCompatibleAiProviderConfig,
): AiProviderPort {
  const id = config.id ?? OPENAI_COMPATIBLE_AI_PROVIDER_ID
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRetries = Math.max(0, config.maxRetries ?? DEFAULT_MAX_RETRIES)
  const retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const doFetch = config.fetch ?? globalThis.fetch

  if (config.apiKey.trim() === "") {
    throw new AiProviderRequestError(
      "AI_PROVIDER_NOT_CONFIGURED",
      "ai provider: apiKey is required (set AI_API_KEY)",
    )
  }
  if (config.userAgent.trim() === "") {
    throw new AiProviderRequestError(
      "AI_PROVIDER_NOT_CONFIGURED",
      "ai provider: userAgent is required (set AI_USER_AGENT) — gateways reject unknown clients",
    )
  }

  /** Redact the key out of anything on its way to a message. */
  function safe(text: string): string {
    return redactIntegrationSecrets(text, config.apiKey).slice(0, 500)
  }

  function errorFor(status: number, body: string): AiProviderRequestError {
    const detail = safe(body.trim() === "" ? "(empty body)" : body)
    if (status === 401 || status === 403) {
      return new AiProviderRequestError(
        "AI_PROVIDER_UNAUTHORIZED",
        `ai provider rejected the credentials (${String(status)}): ${detail}`,
        { status },
      )
    }
    if (status === 429) {
      return new AiProviderRequestError(
        "AI_PROVIDER_RATE_LIMITED",
        `ai provider rate limited (429): ${detail}`,
        { status, retryable: true },
      )
    }
    return new AiProviderRequestError(
      "AI_PROVIDER_UNAVAILABLE",
      `ai provider request failed (${String(status)}): ${detail}`,
      { status, retryable: status === 408 || status >= 500 },
    )
  }

  async function attempt(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error("timeout"))
    }, timeoutMs)
    const onAbort = () => {
      controller.abort(signal?.reason)
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          // Required: some gateways authorise on the client identity too.
          "user-agent": config.userAgent,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw errorFor(response.status, await response.text().catch(() => ""))
      }
      try {
        return (await response.json()) as unknown
      } catch (err) {
        throw new AiProviderRequestError(
          "AI_PROVIDER_INVALID_RESPONSE",
          `ai provider returned a non-JSON body: ${safe(err instanceof Error ? err.message : String(err))}`,
        )
      }
    } catch (err) {
      if (err instanceof AiProviderRequestError) throw err
      if (signal?.aborted) {
        throw new AiProviderRequestError("AI_PROVIDER_TIMEOUT", "ai provider call was cancelled")
      }
      const aborted = err instanceof Error && err.name === "AbortError"
      if (aborted) {
        throw new AiProviderRequestError(
          "AI_PROVIDER_TIMEOUT",
          `ai provider did not answer within ${String(timeoutMs)}ms`,
          { retryable: true },
        )
      }
      throw new AiProviderRequestError(
        "AI_PROVIDER_UNAVAILABLE",
        `ai provider is unreachable: ${safe(err instanceof Error ? err.message : String(err))}`,
        { retryable: true },
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
  }

  async function request(
    body: Record<string, unknown>,
    opts: AiCompleteOptions | undefined,
  ): Promise<AiCompletionResult> {
    const startedAt = Date.now()
    let lastError: AiProviderRequestError | null = null

    for (let attemptNo = 0; attemptNo <= maxRetries; attemptNo += 1) {
      try {
        const payload = await attempt(body, opts?.signal)
        return toCompletion(payload, body, Date.now() - startedAt)
      } catch (err) {
        lastError = err instanceof AiProviderRequestError ? err : null
        if (!lastError?.retryable || attemptNo === maxRetries) throw err
        if (retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
        }
      }
    }
    throw lastError ?? new AiProviderRequestError("AI_PROVIDER_UNAVAILABLE", "ai provider failed")
  }

  function toCompletion(
    payload: unknown,
    body: Record<string, unknown>,
    latencyMs: number,
  ): AiCompletionResult {
    const root = (payload ?? {}) as Record<string, unknown>
    const choices = Array.isArray(root.choices) ? root.choices : []
    const first = (choices[0] ?? {}) as Record<string, unknown>
    const message = (first.message ?? {}) as Record<string, unknown>
    if (choices.length === 0) {
      throw new AiProviderRequestError(
        "AI_PROVIDER_INVALID_RESPONSE",
        "ai provider returned no choices",
      )
    }
    const content = message.content
    return {
      text: typeof content === "string" ? content : "",
      toolCalls: readToolCalls(message.tool_calls),
      finishReason: readFinishReason(first.finish_reason),
      model: typeof root.model === "string" ? root.model : String(body.model ?? config.model),
      providerId: id,
      usage: readUsage(root.usage),
      latencyMs,
    }
  }

  function baseBody(
    messages: readonly AiProviderMessage[],
    opts: AiCompleteOptions | undefined,
  ): Record<string, unknown> {
    const temperature = opts?.temperature ?? config.temperature
    const maxOutputTokens = opts?.maxOutputTokens ?? config.maxOutputTokens
    return {
      model: opts?.model ?? config.model,
      messages: messages.map(toWireMessage),
      stream: false,
      ...(temperature === undefined ? {} : { temperature }),
      ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }),
    }
  }

  return {
    id,
    defaultModel: config.model,
    complete: (messages, opts) => request(baseBody(messages, opts), opts),
    completeWithTools: (messages, tools, opts) =>
      request(
        tools.length === 0
          ? baseBody(messages, opts)
          : { ...baseBody(messages, opts), tools: tools.map(toWireTool), tool_choice: "auto" },
        opts,
      ),
  }
}
