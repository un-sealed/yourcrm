import type {
  AiCompleteOptions,
  AiCompletionResult,
  AiProviderMessage,
  AiProviderPort,
  AiProviderToolCall,
  AiProviderToolDefinition,
  AiTokenUsage,
} from "../types"

/**
 * Deterministic stub provider — the test and offline-development backend,
 * mirroring the console providers that ship with email, WhatsApp and
 * calling.
 *
 * Every test in this repo runs on this: no network, no API key, no clock
 * dependence. Same input, same output, always.
 *
 * Two modes:
 *  - **echo** (default): answers `stub: <last user message>` with usage
 *    derived from character counts, so token accounting is exercised
 *    without inventing randomness;
 *  - **scripted**: `script` supplies the completions in order, which is how
 *    a test drives a tool-calling turn (step 1 asks for `crm_query`, step 2
 *    answers in prose). When the script runs out the echo takes over.
 *
 * `calls` records what the service sent, so tests can assert on the system
 * prompt, the replayed history and the tool definitions offered.
 */

export const STUB_AI_PROVIDER_ID = "stub"

export const STUB_AI_MODEL = "stub-echo-1"

/** One scripted step. Omitted fields fall back to deterministic defaults. */
export type StubAiScriptStep = {
  text?: string
  toolCalls?: readonly AiProviderToolCall[]
  usage?: Partial<AiTokenUsage>
  latencyMs?: number
  model?: string
  /** Throw instead of answering — drives the failure paths. */
  error?: Error
}

export type StubAiCall = {
  messages: AiProviderMessage[]
  tools: AiProviderToolDefinition[]
  options: AiCompleteOptions | undefined
}

export type StubAiProviderOptions = {
  id?: string
  model?: string
  script?: readonly StubAiScriptStep[]
}

export type StubAiProvider = AiProviderPort & {
  /** Every call the service made, in order. Read-only in practice. */
  readonly calls: StubAiCall[]
  /** Scripted steps consumed so far. */
  readonly stepCount: number
}

/** Deterministic, monotonic token estimate. Four characters per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function lastUserText(messages: readonly AiProviderMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && message.role === "user") return message.content
  }
  return ""
}

export function createStubAiProvider(options: StubAiProviderOptions = {}): StubAiProvider {
  const id = options.id ?? STUB_AI_PROVIDER_ID
  const defaultModel = options.model ?? STUB_AI_MODEL
  const script = options.script ?? []
  const calls: StubAiCall[] = []
  let step = 0

  function answer(
    messages: readonly AiProviderMessage[],
    tools: readonly AiProviderToolDefinition[],
    opts: AiCompleteOptions | undefined,
    allowTools: boolean,
  ): AiCompletionResult {
    calls.push({ messages: [...messages], tools: [...tools], options: opts })
    const scripted = step < script.length ? script[step] : undefined
    if (scripted) step += 1
    if (scripted?.error) throw scripted.error

    const toolCalls = allowTools ? [...(scripted?.toolCalls ?? [])] : []
    const text = scripted?.text ?? (toolCalls.length > 0 ? "" : `stub: ${lastUserText(messages)}`)
    const promptChars = messages.reduce((total, message) => total + message.content.length, 0)
    const usage: AiTokenUsage = {
      promptTokens: scripted?.usage?.promptTokens ?? Math.ceil(promptChars / 4),
      completionTokens: scripted?.usage?.completionTokens ?? estimateTokens(text),
      totalTokens: 0,
    }
    usage.totalTokens = scripted?.usage?.totalTokens ?? usage.promptTokens + usage.completionTokens

    return {
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      model: scripted?.model ?? opts?.model ?? defaultModel,
      providerId: id,
      usage,
      latencyMs: scripted?.latencyMs ?? 0,
    }
  }

  return {
    id,
    defaultModel,
    calls,
    get stepCount() {
      return step
    },
    complete: async (messages, opts) => answer(messages, [], opts, false),
    completeWithTools: async (messages, tools, opts) => answer(messages, tools, opts, true),
  }
}
