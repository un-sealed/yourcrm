import { describe, expect, test } from "bun:test"
import { createStubAiProvider } from "./stub-ai-provider"

describe("ai-assistant/stub-provider", () => {
  test("echoes the last user message deterministically", async () => {
    const provider = createStubAiProvider()
    const first = await provider.complete([
      { role: "system", content: "rules" },
      { role: "user", content: "hello" },
    ])
    const second = await createStubAiProvider().complete([
      { role: "system", content: "rules" },
      { role: "user", content: "hello" },
    ])
    expect(first.text).toBe("stub: hello")
    expect(first).toEqual(second)
  })

  test("reports usage and attribution on every call", async () => {
    const provider = createStubAiProvider()
    const completion = await provider.complete([{ role: "user", content: "1234" }])
    expect(completion.providerId).toBe("stub")
    expect(completion.model).toBe("stub-echo-1")
    expect(completion.usage.promptTokens).toBe(1)
    expect(completion.usage.totalTokens).toBe(
      completion.usage.promptTokens + completion.usage.completionTokens,
    )
    expect(completion.latencyMs).toBe(0)
  })

  test("honours a per-call model override for attribution", async () => {
    const completion = await createStubAiProvider().complete([{ role: "user", content: "x" }], {
      model: "other-model",
    })
    expect(completion.model).toBe("other-model")
  })

  test("a script drives a tool-calling turn, then prose", async () => {
    const provider = createStubAiProvider({
      script: [
        { toolCalls: [{ id: "c1", name: "crm_query", arguments: { objectType: "deal" } }] },
        { text: "There are 4 deals." },
      ],
    })
    const step1 = await provider.completeWithTools([{ role: "user", content: "count" }], [])
    expect(step1.toolCalls).toHaveLength(1)
    expect(step1.finishReason).toBe("tool_calls")

    const step2 = await provider.completeWithTools([{ role: "user", content: "count" }], [])
    expect(step2.text).toBe("There are 4 deals.")
    expect(step2.toolCalls).toHaveLength(0)
    expect(provider.stepCount).toBe(2)
  })

  test("complete() never returns tool calls even when scripted", async () => {
    const provider = createStubAiProvider({
      script: [{ toolCalls: [{ id: "c1", name: "crm_query", arguments: {} }] }],
    })
    const completion = await provider.complete([{ role: "user", content: "count" }])
    expect(completion.toolCalls).toHaveLength(0)
    expect(completion.finishReason).toBe("stop")
  })

  test("a scripted error surfaces to the caller", async () => {
    const provider = createStubAiProvider({ script: [{ error: new Error("provider down") }] })
    await expect(provider.complete([{ role: "user", content: "x" }])).rejects.toThrow(
      "provider down",
    )
  })

  test("records what the service sent, for prompt assertions", async () => {
    const provider = createStubAiProvider()
    await provider.completeWithTools(
      [{ role: "user", content: "x" }],
      [{ name: "crm_query", description: "d", parameters: {} }],
      { correlationId: "corr_1" },
    )
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]?.tools[0]?.name).toBe("crm_query")
    expect(provider.calls[0]?.options?.correlationId).toBe("corr_1")
  })
})
