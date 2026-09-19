import { describe, expect, test } from "bun:test"
import {
  AiProviderError,
  emptyAiUsage,
  sumAiUsage,
  type AiCompleteOptions,
  type AiCompletion,
  type AiMessage,
  type AiProvider,
  type AiToolDefinition,
} from "./index"

/**
 * Conformance fixture: the smallest object that satisfies the port. It
 * exists to prove the contract is implementable with no dependencies and to
 * fail compilation the moment the port changes shape incompatibly.
 */
function makeConformingProvider(): AiProvider {
  const answer = (model: string | undefined, text: string): AiCompletion => ({
    text,
    toolCalls: [],
    finishReason: "stop",
    model: model ?? "conformance-model",
    providerId: "conformance",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    latencyMs: 0,
  })
  return {
    id: "conformance",
    defaultModel: "conformance-model",
    complete: async (messages: readonly AiMessage[], opts?: AiCompleteOptions) =>
      answer(opts?.model, `${String(messages.length)} messages`),
    completeWithTools: async (
      messages: readonly AiMessage[],
      tools: readonly AiToolDefinition[],
      opts?: AiCompleteOptions,
    ) => answer(opts?.model, `${String(messages.length)}/${String(tools.length)}`),
  }
}

describe("ai/provider-port", () => {
  test("a dependency-free object satisfies AiProvider", async () => {
    const provider = makeConformingProvider()
    const completion = await provider.complete([{ role: "user", content: "hi" }])
    expect(completion.text).toBe("1 messages")
    expect(completion.providerId).toBe("conformance")
    expect(completion.usage.totalTokens).toBe(2)
  })

  test("completeWithTools takes tool definitions and honours the model override", async () => {
    const provider = makeConformingProvider()
    const completion = await provider.completeWithTools(
      [{ role: "user", content: "count" }],
      [{ name: "crm_query", description: "query", parameters: { type: "object" } }],
      { model: "other-model" },
    )
    expect(completion.text).toBe("1/1")
    expect(completion.model).toBe("other-model")
  })
})

describe("ai/usage", () => {
  test("empty usage is all zeros", () => {
    expect(emptyAiUsage()).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })
  })

  test("usage folds across the steps of one tool loop", () => {
    const total = sumAiUsage([
      { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      { promptTokens: 22, completionTokens: 7, totalTokens: 29 },
    ])
    expect(total).toEqual({ promptTokens: 32, completionTokens: 11, totalTokens: 43 })
  })

  test("summing nothing is zero, not NaN", () => {
    expect(sumAiUsage([])).toEqual(emptyAiUsage())
  })
})

describe("ai/errors", () => {
  test("carries a branchable code, status and retryability", () => {
    const err = new AiProviderError("AI_PROVIDER_RATE_LIMITED", "slow down", {
      status: 429,
      retryable: true,
    })
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe("AI_PROVIDER_RATE_LIMITED")
    expect(err.status).toBe(429)
    expect(err.retryable).toBe(true)
  })

  test("defaults to non-retryable with no status", () => {
    const err = new AiProviderError("AI_PROVIDER_INVALID_RESPONSE", "bad json")
    expect(err.status).toBeNull()
    expect(err.retryable).toBe(false)
  })
})
