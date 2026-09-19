# Integration TODO

Work that agents deliberately **reported instead of doing**, plus defects found
along the way. Agents may not edit `package.json`, generated barrels, or files
they do not own — so these land here for a human (or an integrator pass) to
apply together.

Nothing here is a mystery: every item names the file and the fix.

Status legend: **[!]** breaks a feature if skipped · **[~]** correctness/quality
· **[i]** informational

---

## 0. AI provider cannot do multi-step tool loops — affects two modules

`AI_DEFAULT_MODEL=deepseek-v4-flash` runs in **thinking mode**. Replaying its
assistant turn for a second step returns:

```
400 "The reasoning_content in the thinking mode must be passed back to the API"
```

Neither `AiMessage`/`AiProviderMessage` nor
`packages/crm/src/ai-assistant/providers/openai-compatible-ai-provider.ts`
carries `reasoning_content`, so any loop past one tool round-trip fails.

**This hits both `ai-agents` and the already-merged Ask-Your-CRM assistant.**
`ai-core`'s live verification did a single tool call, which is why it passed.

Two ways out:
1. Add `reasoningContent` to the assistant-message type and round-trip it in
   the provider's request/response mapping (the real fix).
2. Use a non-thinking model — but on the current agentrouter key
   `gpt-5.6-sol` returns `402 Budget pool quota exhausted` and `glm-5.3` has
   no channel, so `deepseek-v4-flash` is the only working option today.

Found by `ai-agents` doing a real multi-step run. Single-step calls work fine.

## 1. Wiring that makes shipped features actually work

**[!] `subscribeSalesSequenceExitWatcher()` is never called.**
`apps/api/src/index.ts` must call it once at boot (next to
`subscribeAutomationDispatcher()`). Without it, sequences stop on unsubscribe
and manual removal but **not on reply** — the single most important thing the
module does. Exported from `apps/api/src/routes/modules/sequences.ts`.

**[!] `apps/api` does not declare `bullmq`.**
`defaultQueue()` in `sequences.ts` logs `sequence_step_enqueued` instead of
enqueuing, so enrollments park at their current step. Same pattern was noted
for automation. Add the dep, then replace the documented four-line body.
Also needs `registerSequenceStepRunner(...)` in the worker bootstrap.

**[!] `subscribeWebhookDeliveryDispatcher()` is never called.**
Must go in `apps/api/src/index.ts` at boot alongside the automation and
sequence watchers, or the webhooks module is inert.

**[!] API-key middleware is not mounted.**
`apps/api/src/lib/api-key-auth.ts` exports `publicApiKeyAuth({ resolve })`;
one line in `apps/api/src/app.ts` after `app.use("*", auth())`. Until then
public API keys authenticate nothing.

**[!] Automation's `notify` action bypasses notification preferences.**
`packages/crm/src/automation` writes notification rows directly via
`createNotification`, so an automation can notify a user inside their quiet
hours or in a category they disabled. Route it through the new
`createNotificationsService.create()` instead. Found and reported by the
notifications agent rather than silently patched (automation wasn't its
module).

**[i] `subscribeNotificationsRealtimeDispatcher()` is already wired** in
`apps/api/src/index.ts` by the notifications agent — the only module that
wired its own boot hook. The other three still need doing.

**[~] Post-merge one-liner: real ticket volume for CS health scores.**
`customer-success` approximates "ticket volume" from `activities` because
`support` was on a parallel branch. Both are merged now — swap it to the real
`tickets` table (documented at the call site).

**[!] `registerCampaignBatchSender(...)` is unbound.**
`apps/worker/src/jobs/campaigns.ts` takes an injected sender; binding it (the
person→email lookup, unsubscribe-link injection, and the call into
`@yourcrm/crm/src/email`) happens at `apps/worker/src/index.ts`. Until then
campaigns claim batches and send nothing.
`apps/api/src/index.ts` must call it once at boot (next to
`subscribeAutomationDispatcher()`). Without it, no domain event ever produces
a webhook delivery — the module is inert. Exported from
`apps/api/src/routes/modules/api-webhooks.ts`.

**[!] Public API-key auth is not mounted.**
`apps/api/src/middleware/auth.ts` is owned by another concern, so the
api-webhooks agent exposed the pieces instead of editing it. One line in
`apps/api/src/app.ts`, immediately after `app.use("*", auth())`:
```ts
import { publicApiKeyAuth } from "./lib/api-key-auth"
import { resolvePublicApiKey } from "./routes/modules/api-webhooks"
app.use("*", publicApiKeyAuth({ resolve: resolvePublicApiKey }))
```
The middleware never overwrites an existing session, so order is safe. Until
it is mounted, `Authorization: Bearer <ycrm_sk_…>` is simply unauthenticated.

**[!] Webhook delivery needs the same `bullmq` wiring as automation.**
`defaultQueue()` in `apps/api/src/routes/modules/api-webhooks.ts` logs
`webhook_delivery_enqueued` instead of enqueuing, so deliveries stay
`pending`. The four-line replacement is documented in that function. The
worker side also needs `registerWebhookSender(...)` in the bootstrap —
`apps/worker/src/jobs/webhooks.ts` explains what to bind, and
`@yourcrm/worker` must declare `@yourcrm/database` to construct the service.

**[!] Run the generators after every merge.**
```
bun run scripts/gen-barrels.ts && bun run scripts/gen-routes.ts && bun install
```
Modules are invisible to `packages/crm/src/index.ts`,
`packages/database/src/schema/index.ts` and
`apps/api/src/routes/modules/index.ts` until this runs — an unmounted route is
a 404, which is exactly how the missing auth routes went unnoticed.

---

## 2. Missing event constants in `@yourcrm/events`

Agents are forbidden from adding constants or using string literals, so any
module needing a missing one emits **no domain events** and audits instead.
Each is a one-line addition to `packages/events/src/envelope.ts` plus the
barrel, then a few `emit` calls in the owning service.

| Group | Constants | Spec |
| --- | --- | --- |
| Sequences | `sequence.enrolled` `.step_executed` `.stopped` `.replied` | 47 §9 |
| Search | `search.executed` `command.executed` | 28 §9 |
| Knowledge Base | `article.created` `.updated` `.published` | 22 §9 |
| Support | `ticket.created` `.assigned` `.escalated` `.resolved` | 21 §9 |
| Security / Teams | `security.setting_changed` `user.invited` `role.updated` `team.member_added` | 40, 41 |
| AI governance | `ai.action_rejected` `ai.action_applied` `ai.policy_changed` `ai.kill_switch_enabled` | 38 §9 |
| MCP | `mcp.connected` `mcp.tool_called` `mcp.write_approved` `mcp.disconnected` | 39 §9 |
| Portal | `portal.login` `portal.quote_accepted` `portal.ticket_created` | 45 §9 |
| Onboarding | `onboarding.started` `.step_completed` `.completed` | 42 §9 |
| API & Webhooks | `webhook.delivery_succeeded` `.delivery_failed` `api_key.created` | 32 §9 |

Note: spec 21 §10 automation hooks are blocked on the Support group — the
automation engine listens on the event bus, so no events means no triggers.

Note: the API & Webhooks group is declared locally in
`packages/crm/src/api-webhooks/event-names.ts` (as `WebhookEvents`) and
imported everywhere in that module — no literals. Move the object verbatim
into `envelope.ts`, add it to the barrel, then reduce that file to a
re-export. These three names must NOT become subscribable: a subscription to
`webhook.delivery_failed` would enqueue a delivery per failed delivery.
`SUBSCRIBABLE_EVENT_NAMES` filters them out and the dispatcher re-checks.

(Already added this session: `CustomObjectEvents`, `IntegrationEvents`,
`ConversationEvents`, `email.bounced`, `email.thread_linked`, `call.started`,
`call.answered`, `call.recording_ready`, plus 22 missing CRM/quote/invoice/
calendar/report/dashboard constants.)

---

## 3. Navigation entries nobody owns

`apps/web/components/nav-sections.ts` is not in any agent's ownership list.
Reachable by URL only until added:

- `/app/sequences` → suggest the **Engage** group
- `/app/settings/onboarding` — **already added** by the onboarding agent (one line)
- `/app/api-webhooks` → suggest a **Settings / Developer** group (spec 32 §2
  names `/app/settings/api`; the page is admin-only in the API)
- `/app/marketing`, `/app/customer-success`, `/app/booking-links` *(pending agents)*
- `/app/book/[slug]` is a **public** page and should NOT appear in nav

---

## 4. Duplication to collapse

**[~] `defaultEmailService()` is duplicated.**
`apps/api/src/routes/modules/sequences.ts` re-creates the private
`defaultService()` composition from `email.ts` because that module exports no
factory. Export one shared factory from `email.ts` and delete the copy.

**[~] `SEARCH_OBJECT_TYPES` is hand-synced across three files.**
`packages/database/src/schema/search.ts`, `packages/crm/src/search/types.ts`
and `apps/web/app/app/search/types.ts` must be edited together whenever a
module becomes searchable (Knowledge Base added `"article"` to all three).
A single shared constant would remove the drift risk.

**[~] The filter model exists in four places.**
`@yourcrm/ui`'s `FilterTree` is canonical; `@yourcrm/crm` and
`@yourcrm/database` restate it structurally (infra/domain may not import UI),
and `saved_views.filter` uses an older `{op, conditions}` encoding that does
**not** match what `FilterBuilder` emits. Reconcile `saved_views` onto the
builder encoding before anything depends on it.

**[~] Route→repository inputs are double-cast.**
`input as unknown as Parameters<typeof repo.create>[2]` appears across route
modules (People established it; everyone mirrored it). It defeats type
checking at exactly the seam where service and repository types could drift.

---

## 5. Schema issues worth fixing before there is data

- **[~] `files.size_bytes` is `INTEGER`** — a 2 GB ceiling on an S3-backed file
  module. Should be `BIGINT`.
- **[~] Currency width is inconsistent** — `VARCHAR(3)` in `deals` and
  `product_prices`, `VARCHAR(8)` in `invoices`, `payments`, `workspaces`.
- **[~] `0040_deals.sql` runs before `0050_pipelines.sql`** (my slot numbering).
  Deals references pipelines, so those can never become real FKs without a
  reordering or an ALTER-only integration migration.
- **[i] `form_submissions."values"`** is a PostgreSQL reserved word and must
  stay quoted in any hand-written SQL.
- **[i] Cross-module FK integration pass.** Every module uses plain uuid for
  cross-module references by design. Adding real FKs later needs one
  ALTER-only migration once all tables exist.

---

## 6. Security follow-ups

- **[!] Rotate the agentrouter API key.** It was pasted into a chat
  transcript. It currently lives only in gitignored `.env`.
- **[~] Email HTML sanitiser is regex-based.** Fine while P0 renders text
  only; needs a real sanitiser (`dompurify`/`sanitize-html`) before any rich
  HTML view ships. Blocked on the no-new-dependencies rule.
- **[~] Residual TOCTOU in webhook delivery.** The SSRF guard resolves and
  vets addresses, but the default `fetch` transport connects by hostname and
  cannot pin to the vetted IP. Closing it needs a custom dispatcher (a new
  dependency). Documented by the agent rather than papered over.
- **[i] API-key role clamp is a no-op today.** `owner` and `admin` allow
  identical actions under the current policy, so an admin minting an
  owner-scoped key is not an escalation *yet*. The clamp starts refusing it
  the moment the shared policy separates the two roles.

- **[~] Human security review not yet done** on: credential encryption
  (`integrations`), webhook signature verification, the `reports` SQL
  allowlist, `automation` permission inheritance, and — when it lands —
  `customer-portal` scope containment. Agents wrote tests proving their own
  designs correct, which is not the same as someone checking the designs are
  right.
- **[~] Webhook SSRF has a residual TOCTOU window.**
  `packages/crm/src/api-webhooks/url-guard.ts` re-resolves and re-checks the
  target before every attempt, but the socket is opened by hostname, so a
  resolver could answer differently between the check and the connect. The
  guard hands the vetted addresses to the transport
  (`WebhookTransportRequest.resolvedAddresses`) so a hardened transport can
  pin one; the default `fetch` transport cannot. Closing it needs a custom
  agent/dispatcher, which needs a dependency.

---

## 6.0 KNOWN MERGE CONFLICTS — `packages/events` (two agents)

Two agents edited `packages/events` despite the rule saying a missing
constant is a blocker to report. In both cases their version is a strict
superset of the one added centrally, and their code depends on it, so
**resolve by taking theirs**.

`NotificationEvents` (from `agent/notifications`) — take theirs verbatim:
`Created, Read, AllRead, Deleted, PreferencesUpdated, Delivered, Failed`.
Mine on `main` has only the first two.

`MarketplaceEvents` — see below.

### MarketplaceEvents

`agent/marketplace-sdk` edited `packages/events/src/{envelope,index}.ts`
despite its prompt saying a missing constant is a blocker to report. Its
version is the better one and its code depends on it, but `main` already has
a different `MarketplaceEvents` group added centrally.

Resolve to the **union**:
```ts
export const MarketplaceEvents = {
  AppRegistered: "app.registered",
  AppInstalled: "app.installed",
  AppUninstalled: "app.uninstalled",
  ScopesGranted: "app.scopes_granted",
  AppScopeDenied: "app.scope_denied",
  AppError: "app.error",
} as const
```
Take theirs and add `ScopesGranted`. Nothing references `ScopesGranted` yet,
so dropping it would also be safe — but it matches spec 49's intent.

## 6a. Shared-file edits from mobile-pwa — review at merge

All documented by the agent, all additive:
- `apps/web/components/app-shell.tsx` — sidebar `hidden md:flex`, plus
  `<OfflineBanner />` and `<MobileNav />`. Desktop behaviour unchanged.
- `apps/web/app/layout.tsx` — manifest, icons, `<ServiceWorkerRegister />`.
- `packages/ui/src/data-table.tsx` — **CSS only** (`min-w-max`,
  `whitespace-nowrap`). No prop or behaviour change; all 9 existing tests and
  every current `<DataTable>` usage pass unmodified. Worth a second look
  anyway since this primitive is used by ~12 modules.
- `apps/web/lib/api-client.ts` — refuses non-GET while offline, throwing
  `ApiError("OFFLINE")` before `fetch`. Never a silent drop.
- PWA icons are generated by `apps/web/scripts/generate-icons.mjs`, not wired
  into any build script (no package.json edits allowed). Re-run by hand if
  the brand colour changes.

## 6b. Review these cross-module changes at merge

- **`packages/database/src/schema/core.ts`** — the settings agent added
  `date_format`, `logo_url`, `brand_color`, `support_email` to `workspaces`
  (additive; the profile stays one row rather than a parallel settings table).
- **`audit_events` is now append-only at the database level** —
  `0320_settings.sql` installs a trigger rejecting UPDATE/DELETE/TRUNCATE.
  Verified nothing in the codebase mutates audit rows. If a future migration
  ever needs to, the rollback is documented in that file's header.
- **Invite acceptance is unimplemented by design.** `checkInviteUsable()` and
  `findInviteByTokenHash()` are the seam; creating the user + membership from
  an invite token belongs to the auth module.

## 6c. Decisions only you can make

**Which objects may AI write?** `AI_ACTION_APPLIERS` in
`apps/api/src/routes/modules/ai-governance.ts` currently binds **only
`person`**, as a worked example. `company`, `deal`, `lead`, `task` are
deliberately unbound — binding an object type *is* the decision to let AI
modify it. Unbound types are refused with a 400, so the safe default holds
until you choose. One line each.

**`send_external` has no bound transport.** It is a governed action, but
approving one currently fails with a clear 400 rather than silently sending.
Wire it to the email service only when you want AI to be able to send.

## 6d. Customer portal — two gaps by design

- **No admin surface to grant portal access.** Deliberately kept out of the
  portal router so it stays 100% customer-facing. `createPortalRepository()`
  exposes `createIdentity`, `createGrant`, `revokeIdentity` — a member-side UI
  needs building before anyone can actually be invited to the portal.
- **Magic-link delivery is a dev console log.** In production it logs a
  warning and sends nothing. Wire it to the email transport once a connection
  is configured, or portal login cannot be completed by a real customer.
- **Ticket reader unwired** — `deps.tickets` is `undefined` until `support`
  merges; tickets read as empty, never unscoped. The port takes the scope as
  its first argument and the implementation must apply it in SQL.

## 6e. MCP needs a host with database access

`apps/mcp` must not depend on the database package (enforced by a source-text
test), so `createMcpServer({runtime, resolveCaller})` takes its ports as
arguments. Production currently defaults to `createUnconfiguredMcpRuntime()`:
it lists the 12 tools and refuses every call with `MCP_RUNTIME_NOT_CONFIGURED`.
Development uses a fixture runtime, so the server is drivable today.

To make MCP real, an integrator must build the runtime from a host that
already has the database — most likely `apps/api`, or a thin `apps/mcp-host`.
Same for session resolution: `MCP_API_TOKEN` exists in the env schema but
resolving it to a user needs the auth store, so the default resolver returns
an anonymous caller that reaches nothing.

## 7. Partial modules (counted as done, but aren't)

- **32 api-webhooks** — ~~no webhook subscription model, no delivery/retry~~
  now implemented (migration 0360: `webhook_subscriptions`,
  `webhook_deliveries`, `api_keys`) but INERT until the three section-1
  wiring items above are applied. OAuth apps and rate-limit buckets from
  spec 32 §6 are still absent (P1).
- **41 users-teams-permissions** — auth + policy engine exist; teams UI is
  being built by the `settings` agent.
- **43 notifications** — table and contract exist; no module, no delivery.

---

## 8. Repo hygiene

- **[i] `bun run format` on `main`** would reformat ~79 files that were
  already prettier-dirty before this work. Four separate agents noticed and
  correctly declined to bundle it. Worth doing as its own commit.
- **[i] The first 8 opencode commits** are authored as the repo owner with no
  co-author line (they predate the `prepare-commit-msg` hook). Fixing means
  rewriting 8 commits plus merges — safe, since nothing is shared, but it is
  history rewriting and needs an explicit decision.
- **[i] Per-agent databases** (`yourcrm_<module>`, ~25 of them) can be dropped
  once their branches are merged.
- **[i] Agent worktrees** — `./docs/agent-prompts/launch.sh down` removes
  merged ones; branches are preserved either way.

---

## 9. AI agents (spec 36) — reported, not done

**[!] Wire the module at merge.** `bun run scripts/gen-barrels.ts &&
bun run scripts/gen-routes.ts` to pick up `packages/crm/src/ai-agents`,
`packages/database/src/schema/ai-agents.ts` and
`apps/api/src/routes/modules/ai-agents.ts` (base path `/ai/agents`).

**[!] `apps/api` does not declare `bullmq`.** `defaultQueue()` in
`routes/modules/ai-agents.ts` logs `ai_agent_run_enqueued` instead of
enqueuing, so agent runs are recorded but never executed. Same gap as
automation and sequences. The four-line replacement is documented at the
call site; the job name, payload and deterministic job id live in
`apps/worker/src/jobs/ai-agent.ts`.

**[!] `registerAiAgentRunner(...)` is unbound.** `apps/worker/src/index.ts`
must bind it to the agent service's `executeRun`, or `ai.agent.run` jobs
dead-letter with `AI_AGENT_RUNNER_NOT_BOUND` (loudly, by design).

**[!] `subscribeAiAgentRuns()` is never called.** One line in
`apps/api/src/index.ts` at boot, next to the automation dispatcher, or
event-triggered agents never wake up. Manual runs work either way.

**[~] Missing event constants.** Spec 36 §9 names `agent.published` and
`agent.run_started`; `@yourcrm/events` has neither (only
`AiEvents.AgentCompleted`). Per the rules this is reported, not added — the
module emits `AgentCompleted` and `ToolCalled`, and enable/disable plus run
start are fully covered by audit rows meanwhile.

**[~] One shared-file edit.** `apps/api/src/routes/modules/ai-governance.ts`
gained a single trailing line exporting its existing composition root as
`createDefaultAiGovernanceService`, so the agents module proposes through
THE governance service rather than wiring a second one. Nothing else in
that file changed. `apps/worker/src/worker.ts` gained the usual two lines
registering a job handler.

**[!] The default model breaks multi-step tool loops on this gateway.**
`AI_DEFAULT_MODEL=deepseek-v4-flash` runs in thinking mode, and replaying
its assistant turn back for a second step is rejected with
`400 … "The reasoning_content in the thinking mode must be passed back to
the API"`. This is a PROVIDER gap, not an agent one, and it hits the
Ask-Your-CRM assistant's tool loop identically: neither
`AiMessage`/`AiProviderMessage` nor `openai-compatible-ai-provider.ts`
carries `reasoning_content`. Fix is one optional field on the assistant
message plus pass-through in the provider, in `packages/crm/src/ai-assistant`
(and the mirrored type in `packages/ai`). Verified live; a single-step agent
run works end to end today. `gpt-5.6-sol` on the same gateway answers
`402 Budget pool quota has been exhausted`.

**[i] `packages/agents` stays a Phase-3 placeholder.** It declares only
`@yourcrm/events`, so it cannot import `@yourcrm/crm`, `@yourcrm/ai` or
`@yourcrm/permissions`, and agents may not edit `package.json`. The module
therefore lives in `packages/crm/src/ai-agents` next to the assistant and
the approval queue it is built from — the same call the AI-core agent made
for the providers. Moving it later is mechanical.
