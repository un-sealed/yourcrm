# 02 — Critical Functional Gaps

The modules here have UI, API routes, migrations, domain services and unit
tests — and **still do not work end to end**, because the background half of
each is stubbed with a log line instead of a real enqueue, and the worker
never binds the runners those jobs call. This is the highest-impact category
in the audit. Each item was re-verified against current `main`, so it reflects
reality rather than `docs/INTEGRATION-TODO.md`'s original snapshot.

There is a common root cause for the queue half:

> **`apps/api/package.json` does not declare `bullmq`**, and agents were not
> allowed to edit `package.json`. Six API route modules therefore implement
> their `defaultQueue()` as a structured `console.log` of the would-be job.
> Nothing is ever pushed to Redis, so nothing is ever picked up by the worker.

And a second root cause for the execution half:

> **`apps/worker/src/index.ts` registers no runners.** `createWorker()` wires
> job *handlers* (`apps/worker/src/worker.ts`), but each handler delegates to
> an injected port whose default throws a `*_NOT_BOUND` error until
> `registerX(...)` is called at boot. No `register*` call exists in the worker
> bootstrap.

## 2.1 CRITICAL — background jobs are never enqueued (API side)

`apps/api` has no `bullmq` dependency (`apps/api/package.json`). Six modules
log instead of enqueue:

| Module | File | Log line emitted instead |
| --- | --- | --- |
| Automation | `apps/api/src/routes/modules/automation.ts:99` | `workflow_run_enqueued` |
| Sequences | `apps/api/src/routes/modules/sequences.ts:126` | `sequence_step_enqueued` |
| Marketing campaigns | `apps/api/src/routes/modules/marketing.ts:85` | `campaign_batch_enqueued` |
| AI agents | `apps/api/src/routes/modules/ai-agents.ts:125` | `ai_agent_run_enqueued` |
| API webhooks | `apps/api/src/routes/modules/api-webhooks.ts:96` | `webhook_delivery_enqueued` |
| Conversation intelligence | `apps/api/src/routes/modules/conversation-intelligence.ts:153` | `conversation_analysis_enqueued` |

**Impact.** Workflow runs, sequence steps, campaign sends, agent runs,
webhook deliveries and conversation analyses are all recorded in the database
and then never execute. From the user's point of view the feature "works"
(the row appears, the API returns 201) but nothing ever happens — the worst
possible failure mode, because it is silent.

**Fix (mechanical):**
1. Add `"bullmq": "^5.x"` to `apps/api/package.json` dependencies and
   `bun install`.
2. Replace each `defaultQueue()` body with the four-line `getQueue(...).add(...)`
   implementation documented in the comment at each call site. The job names
   and payload shapes already exist in `apps/worker/src/jobs/*`.
3. Note: the marketing campaign batch is the one exception that **self-enqueues
   from the worker** and does not need this fix (`apps/worker/src/jobs/campaigns.ts`
   already declares `bullmq`) — but it still needs 2.2.

## 2.2 CRITICAL — worker runners are never registered

`apps/worker/src/index.ts` imports only `loadEnv`, `getRedis`, `closeQueues`
and `createWorker`. None of the `register*` functions are called, so every
corresponding job dead-letters with `*_NOT_BOUND`:

| Port | Default error | File |
| --- | --- | --- |
| Workflow runner | `WORKFLOW_RUNNER_NOT_BOUND` | `apps/worker/src/jobs/automation.ts:97` |
| Sequence step runner | `SEQUENCE_RUNNER_NOT_BOUND` | `apps/worker/src/jobs/sequences.ts:92` |
| Campaign batch sender | `CAMPAIGN_BATCH_SENDER_NOT_BOUND` | `apps/worker/src/jobs/campaigns.ts:89` |
| Webhook sender | `WEBHOOK_SENDER_NOT_BOUND` | `apps/worker/src/jobs/webhooks.ts:105` |
| AI agent runner | `AI_AGENT_RUNNER_NOT_BOUND` | `apps/worker/src/jobs/ai-agent.ts:102` |
| Conversation analysis runner | `CONVERSATION_ANALYSIS_RUNNER_NOT_BOUND` | `apps/worker/src/jobs/conversation-intelligence.ts:99` |

**Impact.** Even if 2.1 is fixed, these jobs fail loudly (by design — that is
the good part). The failures would flood the dead-letter queue rather than
perform work.

**Fix:** bind each port in `apps/worker/src/index.ts` immediately after
`createWorker()` — the JSDoc above each `register*` function states exactly
what to bind (e.g. `apiWebhooksService.executeDelivery`, the agent service's
`executeRun`, the campaign sender's person→email + unsubscribe-link
composition). `apps/worker` already declares `@yourcrm/crm` and
`@yourcrm/database`, so the services are constructible there.

**Missing test.** Nothing in the suite proves the worker bootstrap wires
these. A single smoke test that imports the bootstrap and asserts every port
is bound would have caught this class of bug. Add one (see `08`).

## 2.3 CRITICAL — API boot hooks are missing

`apps/api/src/index.ts` calls exactly two subscriptions:
`subscribeAutomationDispatcher()` and
`subscribeNotificationsRealtimeDispatcher()`. Three more are exported and
never called:

| Missing boot call | Exported from | Impact if skipped |
| --- | --- | --- |
| `subscribeSalesSequenceExitWatcher()` | `apps/api/src/routes/modules/sequences.ts` | Sequences do **not stop on reply** — the single most important behaviour of the module. |
| `subscribeWebhookDeliveryDispatcher()` | `apps/api/src/routes/modules/api-webhooks.ts` | No domain event ever produces a webhook delivery; webhooks are inert. |
| `subscribeAiAgentRuns()` | `apps/api/src/routes/modules/ai-agents.ts` | Event-triggered agents never wake up (manual runs still work). |

**Fix:** add each call at boot in `apps/api/src/index.ts`, next to the existing
dispatcher subscriptions, matching the documented pattern.

## 2.4 CRITICAL — public API-key authentication is not mounted

`apps/api/src/lib/api-key-auth.ts` exports `publicApiKeyAuth({ resolve })` and
`apps/api/src/routes/modules/api-webhooks.ts` exports `resolvePublicApiKey`,
but `apps/api/src/app.ts` never mounts the middleware. Consequence:
**`Authorization: Bearer ycrm_sk_…` requests authenticate nothing** and fall
through as anonymous. Any public-API feature is dead on arrival.

**Fix:** in `apps/api/src/app.ts`, immediately after `app.use("*", auth())`:

```ts
import { publicApiKeyAuth } from "./lib/api-key-auth"
import { resolvePublicApiKey } from "./routes/modules/api-webhooks"
app.use("*", publicApiKeyAuth({ resolve: resolvePublicApiKey }))
```

The middleware never overwrites an existing session, so ordering is safe.

## 2.5 HIGH — automation `notify` bypasses notification preferences

`packages/crm/src/automation` writes notification rows directly via
`createNotification`, so an automation can notify a user inside their quiet
hours or in a notification category they disabled. The notifications module
has the correct path (`createNotificationsService.create()`); automation does
not use it.

**Fix:** route automation notifications through
`@yourcrm/crm`'s notifications service. This was reported by the notifications
agent rather than silently patched; it is still open.

## 2.6 MEDIUM — customer-success ticket volume is approximated

`packages/crm/src/customer-success` approximates "ticket volume" from the
`activities` table because `support` was developed on a parallel branch. Both
are merged now; the health-score input is still an approximation and diverges
from real ticket data.

**Fix:** swap the approximation for the real `tickets` table. The call site is
documented in-code.

## 2.7 MEDIUM — AI multi-step tool loops fail on the default model

`AI_DEFAULT_MODEL=deepseek-v4-flash` runs in thinking mode; replaying its
assistant turn for a second step returns
`400 "The reasoning_content in the thinking mode must be passed back to the API"`.
Neither `AiMessage`/`AiProviderMessage` nor
`packages/crm/src/ai-assistant/providers/openai-compatible-ai-provider.ts`
carries `reasoning_content`.

**Impact.** Ask-Your-CRM and `ai-agents` both fail on any loop past one tool
round-trip. Single-step calls pass (which is why the live verification passed).

**Fix:** add an optional `reasoningContent` field to the assistant message
type and round-trip it in the provider's request/response mapping (also mirror
it in `packages/ai/src/provider.ts`). Alternative: use a non-thinking model —
but on the current gateway key there is no such working option.

## 2.8 MEDIUM — portal login cannot be completed by a real customer

Two portal gaps (documented in `docs/INTEGRATION-TODO.md` §6d):

- **Magic-link delivery is a dev console log.** In production it logs a
  warning and sends nothing, so portal login cannot be completed.
- **Ticket reader unwired.** `deps.tickets` is `undefined`, so portal tickets
  read as empty (never unscoped — the safe default). Now that `support` has
  merged, this can be wired.

**Fix:** wire magic-link delivery to the email transport once a connection is
configured; pass the real support repository into the portal service.

## 2.9 INFO — MCP production runtime is unconfigured by design

`apps/mcp` must not depend on the database (enforced by a source-text test),
so its ports are injected. Production defaults to
`createUnconfiguredMcpRuntime()`, which lists the 12 tools and refuses every
call with `MCP_RUNTIME_NOT_CONFIGURED`. Development uses a fixture runtime.
Making MCP real requires a host process with DB access (most likely
`apps/api`). This is a documented, intentional deferral — flagged so it is not
mistaken for a bug.

## Summary

| # | Severity | Item | Fix location |
| --- | --- | --- | --- |
| 2.1 | CRITICAL | Jobs never enqueued (6 modules) | `apps/api/package.json` + 6 route modules |
| 2.2 | CRITICAL | Worker runners unbound (6 ports) | `apps/worker/src/index.ts` |
| 2.3 | CRITICAL | 3 API boot hooks missing | `apps/api/src/index.ts` |
| 2.4 | CRITICAL | API-key auth not mounted | `apps/api/src/app.ts` |
| 2.5 | HIGH | Automation bypasses notification prefs | `packages/crm/src/automation` |
| 2.6 | MEDIUM | CS ticket volume approximated | `packages/crm/src/customer-success` |
| 2.7 | MEDIUM | AI multi-step tool loops fail | `packages/crm/src/ai-assistant` |
| 2.8 | MEDIUM | Portal magic-link + tickets unwired | portal route/service |
| 2.9 | INFO | MCP prod runtime unconfigured (by design) | `apps/mcp` |
