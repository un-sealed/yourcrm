# `@yourcrm/ai`

The AI service boundary: the **`AiProvider` port** every AI feature in
YourCRM is written against, plus its message, tool, usage and error types.

```ts
import type { AiProvider } from "@yourcrm/ai"

const completion = await provider.complete([{ role: "user", content: "hi" }])
completion.text //=> string
completion.model //=> which model answered (attribution)
completion.usage //=> { promptTokens, completionTokens, totalTokens }
completion.latencyMs //=> for ai_runs.latency_ms
```

## The contract

```ts
type AiProvider = {
  readonly id: string
  readonly defaultModel: string
  complete(messages: readonly AiMessage[], opts?: AiCompleteOptions): Promise<AiCompletion>
  completeWithTools(
    messages: readonly AiMessage[],
    tools: readonly AiToolDefinition[],
    opts?: AiCompleteOptions,
  ): Promise<AiCompletion>
}
```

Rules baked into the shape:

- **Usage is never optional.** Every call reports tokens and latency, so
  every call is recordable in `ai_runs` with a cost.
- **Attribution travels with the answer.** `model` and `providerId` come
  back on the completion, not just from config.
- **Tools are described, never executed, here.** `completeWithTools`
  returns the calls the model *wants*; running them under the caller's
  permissions is the assistant service's job. A provider never touches CRM
  data.
- **No secret reaches an error.** Implementations redact before throwing.
- **Streaming is a P1 extension** of this same type (`streamComplete`),
  not a second port.

## Where the implementations live

`packages/ai` is not yet a declared dependency of `apps/api`, `apps/worker`,
`apps/mcp` or `packages/crm`, so `import "@yourcrm/ai"` does not resolve
from any of them (bun symlinks only declared dependencies). Until that is
fixed, the shipping implementations live in
`packages/crm/src/ai-assistant/providers/`:

- `createOpenAiCompatibleAiProvider` — `POST {baseUrl}/chat/completions`
  with `fetch`, always sending `AI_USER_AGENT` (gateways reject
  unrecognised clients), a per-attempt timeout and one bounded retry.
- `createStubAiProvider` — deterministic echo/scripted provider. **Every
  test uses this; no test touches the network.**

They are written against `AiProviderPort`, a byte-identical structural
mirror of `AiProvider` (the same pattern
`packages/crm/src/integrations/types.ts` uses for `IntegrationProviderPort`).
Once `"@yourcrm/ai": "workspace:*"` is added to `packages/crm` and
`apps/api`, the move is mechanical: the mirror collapses to
`export type AiProviderPort = AiProvider` and the two provider files move
here unchanged.

## Consumers

The Ask-Your-CRM assistant (`@yourcrm/crm/src/ai-assistant`), and later AI
fields, agents, conversation intelligence and MCP tools. All of them
receive a provider by injection: none of them reads `AI_API_KEY`, and none
of them calls `fetch` itself.
