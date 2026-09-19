# Integration TODO

Work that agents deliberately **reported instead of doing**, plus defects found
along the way. Agents may not edit `package.json`, generated barrels, or files
they do not own — so these land here for a human (or an integrator pass) to
apply together.

Nothing here is a mystery: every item names the file and the fix.

Status legend: **[!]** breaks a feature if skipped · **[~]** correctness/quality
· **[i]** informational

---

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

Note: spec 21 §10 automation hooks are blocked on the Support group — the
automation engine listens on the event bus, so no events means no triggers.

(Already added this session: `CustomObjectEvents`, `IntegrationEvents`,
`ConversationEvents`, `email.bounced`, `email.thread_linked`, `call.started`,
`call.answered`, `call.recording_ready`, plus 22 missing CRM/quote/invoice/
calendar/report/dashboard constants.)

---

## 3. Navigation entries nobody owns

`apps/web/components/nav-sections.ts` is not in any agent's ownership list.
Reachable by URL only until added:

- `/app/sequences` → suggest the **Engage** group
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
- **[~] Human security review not yet done** on: credential encryption
  (`integrations`), webhook signature verification, the `reports` SQL
  allowlist, `automation` permission inheritance, and — when it lands —
  `customer-portal` scope containment. Agents wrote tests proving their own
  designs correct, which is not the same as someone checking the designs are
  right.

---

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

## 7. Partial modules (counted as done, but aren't)

- **32 api-webhooks** — OpenAPI generation exists; no webhook subscription
  model, no delivery/retry.
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
