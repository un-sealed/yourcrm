import { describe, expect, test } from "bun:test"
import {
  AiProviderRequestError,
  createOpenAiCompatibleAiProvider,
  type OpenAiCompatibleAiProviderConfig,
} from "./openai-compatible-ai-provider"

/**
 * Hermetic provider tests: every call goes through an injected fake
 * `fetch`. Nothing here touches the network, and the fake key below is the
 * only credential this repository ever sees.
 */

const FAKE_KEY = "sk-test-not-a-real-key-000000"

type Recorded = { url: string; init: RequestInit }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function completionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "deepseek-v4-flash",
    choices: [{ message: { role: "assistant", content: "four" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    ...overrides,
  }
}

function makeProvider(
  responder: (call: Recorded, index: number) => Response | Promise<Response>,
  overrides: Partial<OpenAiCompatibleAiProviderConfig> = {},
) {
  const calls: Recorded[] = []
  const provider = createOpenAiCompatibleAiProvider({
    baseUrl: "https://gateway.test/v1/",
    apiKey: FAKE_KEY,
    model: "deepseek-v4-flash",
    userAgent: "yourcrm-test/1.0",
    retryDelayMs: 0,
    fetch: (async (url: string, init: RequestInit) => {
      const call = { url, init }
      calls.push(call)
      return responder(call, calls.length - 1)
    }) as unknown as typeof globalThis.fetch,
    ...overrides,
  })
  return { provider, calls }
}

function headerOf(call: Recorded | undefined, name: string): string | undefined {
  const headers = call?.init.headers as Record<string, string> | undefined
  return headers?.[name]
}

function bodyOf(call: Recorded | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body ?? "{}")) as Record<string, unknown>
}

describe("ai-assistant/openai-compatible-provider", () => {
  test("posts to /chat/completions with the User-Agent every gateway checks", async () => {
    const { provider, calls } = makeProvider(() => jsonResponse(completionBody()))
    const completion = await provider.complete([{ role: "user", content: "2+2?" }])

    expect(calls[0]?.url).toBe("https://gateway.test/v1/chat/completions")
    expect(headerOf(calls[0], "user-agent")).toBe("yourcrm-test/1.0")
    expect(headerOf(calls[0], "authorization")).toBe(`Bearer ${FAKE_KEY}`)
    expect(headerOf(calls[0], "content-type")).toBe("application/json")
    expect(completion.text).toBe("four")
    expect(completion.model).toBe("deepseek-v4-flash")
    expect(completion.providerId).toBe("openai-compatible")
    expect(completion.usage).toEqual({ promptTokens: 11, completionTokens: 3, totalTokens: 14 })
    expect(completion.latencyMs).toBeGreaterThanOrEqual(0)
  })

  test("a missing user agent or key is refused at construction", () => {
    expect(() =>
      createOpenAiCompatibleAiProvider({
        baseUrl: "https://gateway.test/v1",
        apiKey: FAKE_KEY,
        model: "m",
        userAgent: "  ",
      }),
    ).toThrow("userAgent is required")
    expect(() =>
      createOpenAiCompatibleAiProvider({
        baseUrl: "https://gateway.test/v1",
        apiKey: "",
        model: "m",
        userAgent: "ua",
      }),
    ).toThrow("apiKey is required")
  })

  test("tool definitions and tool results map onto the wire format", async () => {
    const { provider, calls } = makeProvider(() =>
      jsonResponse(
        completionBody({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_9",
                    type: "function",
                    function: { name: "crm_query", arguments: '{"objectType":"deal"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      ),
    )

    const completion = await provider.completeWithTools(
      [
        { role: "user", content: "count deals" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "crm_query", arguments: { objectType: "deal" } }],
        },
        { role: "tool", content: '{"rows":[]}', toolCallId: "call_1", name: "crm_query" },
      ],
      [{ name: "crm_query", description: "query", parameters: { type: "object" } }],
    )

    const body = bodyOf(calls[0])
    const messages = body.messages as Record<string, unknown>[]
    expect((body.tools as Record<string, unknown>[])[0]).toEqual({
      type: "function",
      function: { name: "crm_query", description: "query", parameters: { type: "object" } },
    })
    expect(body.tool_choice).toBe("auto")
    expect(messages[1]?.content).toBeNull()
    expect(messages[1]?.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "crm_query", arguments: '{"objectType":"deal"}' },
      },
    ])
    expect(messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: '{"rows":[]}',
    })

    expect(completion.finishReason).toBe("tool_calls")
    expect(completion.toolCalls).toEqual([
      { id: "call_9", name: "crm_query", arguments: { objectType: "deal" } },
    ])
    expect(completion.text).toBe("")
  })

  test("malformed tool arguments degrade to an empty object, not a crash", async () => {
    const { provider } = makeProvider(() =>
      jsonResponse(
        completionBody({
          choices: [
            {
              message: {
                role: "assistant",
                tool_calls: [{ id: "c", function: { name: "crm_query", arguments: "{not json" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      ),
    )
    const completion = await provider.completeWithTools([{ role: "user", content: "x" }], [])
    expect(completion.toolCalls[0]?.arguments).toEqual({})
  })

  test("retries a 500 exactly once and then succeeds", async () => {
    const { provider, calls } = makeProvider((_call, index) =>
      index === 0 ? jsonResponse({ error: "boom" }, 500) : jsonResponse(completionBody()),
    )
    const completion = await provider.complete([{ role: "user", content: "x" }])
    expect(calls).toHaveLength(2)
    expect(completion.text).toBe("four")
  })

  test("gives up after the bounded retry", async () => {
    const { provider, calls } = makeProvider(() => jsonResponse({ error: "boom" }, 503))
    await expect(provider.complete([{ role: "user", content: "x" }])).rejects.toMatchObject({
      code: "AI_PROVIDER_UNAVAILABLE",
      status: 503,
    })
    expect(calls).toHaveLength(2)
  })

  test("does not retry an authorisation failure", async () => {
    const { provider, calls } = makeProvider(() =>
      jsonResponse({ error: "unauthorized client detected" }, 401),
    )
    const error = (await provider
      .complete([{ role: "user", content: "x" }])
      .catch((err: unknown) => err)) as AiProviderRequestError
    expect(error).toBeInstanceOf(AiProviderRequestError)
    expect(error.code).toBe("AI_PROVIDER_UNAUTHORIZED")
    expect(error.retryable).toBe(false)
    expect(calls).toHaveLength(1)
  })

  test("rate limiting is retryable and typed", async () => {
    const { provider, calls } = makeProvider((_call, index) =>
      index === 0 ? jsonResponse({ error: "slow down" }, 429) : jsonResponse(completionBody()),
    )
    await provider.complete([{ role: "user", content: "x" }])
    expect(calls).toHaveLength(2)
  })

  /** The rule that matters most: a key can never travel in an error. */
  test("the api key never appears in an error message, even when echoed back", async () => {
    const { provider } = makeProvider(() =>
      jsonResponse({ error: `bad key ${FAKE_KEY} rejected` }, 400),
    )
    const error = (await provider
      .complete([{ role: "user", content: "x" }])
      .catch((err: unknown) => err)) as AiProviderRequestError
    expect(error.message).not.toContain(FAKE_KEY)
    expect(error.message).toContain("[redacted]")
  })

  test("a transport failure is wrapped, redacted and retried", async () => {
    const { provider, calls } = makeProvider(() => {
      throw new Error(`connect ECONNREFUSED with ${FAKE_KEY}`)
    })
    const error = (await provider
      .complete([{ role: "user", content: "x" }])
      .catch((err: unknown) => err)) as AiProviderRequestError
    expect(calls).toHaveLength(2)
    expect(error.code).toBe("AI_PROVIDER_UNAVAILABLE")
    expect(error.message).not.toContain(FAKE_KEY)
  })

  test("a slow provider times out with a typed error", async () => {
    const { provider } = makeProvider(
      async (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          })
        }),
      { timeoutMs: 5, maxRetries: 0 },
    )
    await expect(provider.complete([{ role: "user", content: "x" }])).rejects.toMatchObject({
      code: "AI_PROVIDER_TIMEOUT",
    })
  })

  test("a caller abort cancels the call", async () => {
    const controller = new AbortController()
    const { provider } = makeProvider(
      async (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          })
        }),
      { maxRetries: 0 },
    )
    const pending = provider.complete([{ role: "user", content: "x" }], {
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: "AI_PROVIDER_TIMEOUT" })
  })

  test("a response with no choices is an invalid-response error", async () => {
    const { provider } = makeProvider(() => jsonResponse({ choices: [] }))
    await expect(provider.complete([{ role: "user", content: "x" }])).rejects.toMatchObject({
      code: "AI_PROVIDER_INVALID_RESPONSE",
    })
  })

  test("usage is reported as zeros rather than undefined when absent", async () => {
    const { provider } = makeProvider(() =>
      jsonResponse({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }),
    )
    const completion = await provider.complete([{ role: "user", content: "x" }])
    expect(completion.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })
  })

  test("temperature and max tokens are forwarded when configured", async () => {
    const { provider, calls } = makeProvider(() => jsonResponse(completionBody()), {
      temperature: 0.2,
      maxOutputTokens: 512,
    })
    await provider.complete([{ role: "user", content: "x" }], { model: "other" })
    const body = bodyOf(calls[0])
    expect(body.model).toBe("other")
    expect(body.temperature).toBe(0.2)
    expect(body.max_tokens).toBe(512)
    expect(body.stream).toBe(false)
  })
})
