# 07 — Web UI Pages

Every route directory under `apps/web/app` was enumerated and cross-checked for
a `page.tsx`, a `loading.tsx`, an `error.tsx`, navigation reachability, and an
e2e spec. The list pages share a strong, consistent pattern (client component,
`useQuery`-style load, `DataTable`, `EmptyState`, `ErrorState`, `FilterBuilder`,
`SavedViews`, cursor pagination, bulk actions) — the reference is
`apps/web/app/app/companies/page.tsx`. Findings are the exceptions to that.

## 7.1 Route inventory

Legend: `page` = concrete `page.tsx` (not `ModulePlaceholder`); `L/E` =
has `loading.tsx` / `error.tsx` at the list route; `nav` = linked from
`components/nav-sections.ts`; `e2e` = has a Playwright spec.

| Module | Route | page | L/E | nav | e2e |
| --- | --- | --- | --- | --- | --- |
| Dashboard (home) | `/app/dashboard` | ✅ (stub) | —/— | ✅ | smoke only |
| People | `/app/people`, `/[id]`, `/new` | ✅ | ✅/✅ (list, id) | ✅ | — |
| Companies | `/app/companies`, `/[id]`, `/new` | ✅ | ✅/✅ (list, id) | ✅ | — |
| Leads | `/app/leads`, `/[id]` | ✅ | ✅/✅ (list) | ✅ | — |
| Deals | `/app/deals`, `/[id]` | ✅ | ✅/✅ (list) | ✅ | — |
| Activities | `/app/activities`, `/[id]`, `/new` | ✅ | ✅/✅ (list) | ✅ | — |
| Tasks | `/app/tasks`, `/[id]` | ✅ | ✅/✅ (list) | ✅ | — |
| Calendar | `/app/calendar`, `/[id]`, `/new`, `/agenda` | ✅ | ✅/✅ (list, id) | ✅ | — |
| Inbox | `/app/inbox` | ✅ | ✅/✅ | ✅ | — |
| Email | `/app/email`, `/[id]`, `/new` | ✅ | ✅/✅ (list, id) | ✅ | ✅ |
| WhatsApp | `/app/whatsapp`, `/[id]`, `/new` | ✅ | ✅/✅ (list, id) | ✅ | — |
| Calling | `/app/calling`, `/[id]`, `/new` | ✅ | ✅/✅ (list, id) | ✅ | — |
| Products | `/app/products`, `/[id]` | ✅ | ✅/✅ (list) | ✅ | — |
| Quotes | `/app/quotes`, `/[id]`, `/new` | ✅ | ✅/✅ (list, id) | ✅ | — |
| Invoices | `/app/invoices`, `/[id]`, `/new` | ✅ | ✅/✅ (list, id) | ✅ | — |
| Tickets | `/app/tickets`, `/[id]`, `/new` | ✅ | ✅/✅ (list, id) | ✅ | — |
| Knowledge Base | `/app/knowledge-base`, `/[id]`, `/new` | ✅ | ✅/✅ (list) | ✅ | — |
| Forms | `/app/forms`, `/[id]` | ✅ | ✅/✅ (list) | ✅ | — |
| Automation | `/app/automation`, `/[id]`, `/new`, `/runs` | ✅ | ✅/✅ (list) | ✅ | ✅ |
| Reports | `/app/reports`, `/[id]`, `/new` | ✅ | ✅/✅ (list, id) | ✅ | — |
| Dashboards | `/app/dashboards`, `/[id]` | ✅ | ✅/✅ | ❌ | — |
| Analytics | `/app/analytics` | ❌ placeholder | —/— | ✅ | — |
| Search | `/app/search` | ✅ | ✅/✅ | ✅ | — |
| Import/Export | `/app/import-export`, `/[id]` | ✅ | ✅/✅ (list) | ✅ | — |
| Integrations | `/app/integrations` | ✅ | ✅/✅ | ✅ | — |
| Custom Objects | `/app/custom-objects`, `/[slug]`, `/records/[id]`, `/records/new` | ✅ | ✅/✅ | ✅ | — |
| AI Assistant | `/app/ai`, `/agents`, `/governance` | ✅ | ✅/✅ | ✅ | ✅✅✅ |
| Settings | `/app/settings`, `/onboarding`, `/notifications` | ✅ | ✅/✅ | ✅ (2) | ✅ |
| Marketplace | `/app/marketplace`, `/[id]` | ✅ | ✅/✅ | ❌ | — |
| Files | `/app/files`, `/[id]` | ✅ | ✅/✅ | ❌ | — |
| Booking Links | `/app/booking-links`, `/[id]`, `/new` | ✅ | ✅/✅ | ❌ | — |
| Pipelines | `/app/pipelines`, `/[id]` | ✅ | ✅/✅ | ❌ | — |
| Marketing | `/app/marketing`, `/segments(+/[id],/new)`, `/campaigns(+/[id],/new)` | ✅ | ✅/✅ | ❌ | ✅ |
| Sequences | `/app/sequences`, `/[id]`, `/new` | ✅ | ✅/✅ | ❌ | ✅ |
| Customer Success | `/app/customer-success`, `/[id]`, `/new` | ✅ | ✅/✅ | ❌ | — |
| Conversation Intelligence | `/app/conversation-intelligence` | ✅ | ✅/✅ | ❌ | ✅ |
| Notifications | `/app/notifications` | ✅ | ✅/✅ | ❌ (bell only) | — |
| API & Webhooks | `/app/api-webhooks` | ✅ | ✅/✅ | ❌ | — |
| Customer Portal (public) | `/portal`, `/verify`, `/login`, `/invoices`, `/quotes`, `/tickets`, `/tickets/[id]` | ✅ | partial | public | ✅ |
| Public booking (public) | `/book/[slug]` | ✅ | ✅/✅ | public | — |
| Unsubscribe (public) | `/unsubscribe` | ✅ | —/— | public | — |
| Auth | `/login`, `/signup`, `/onboarding` | ✅ | partial | public | — |

Concrete pages exist for **every implemented module**; the only placeholder in
the tree is the `[section]` catch-all (correct) and `/app/analytics` (see 7.3).

## 7.2 HIGH — several fully-built modules are unreachable from the UI

`components/nav-sections.ts` links 29 routes. Eight implemented modules have
**no navigation entry and no inbound link from any other page**, so they are
reachable only by typing the URL (and the command palette, which is built from
the same nav list, so it does not help either):

- `/app/marketing` (+ segments/campaigns)
- `/app/customer-success`
- `/app/sequences`
- `/app/booking-links`
- `/app/files`
- `/app/marketplace`
- `/app/dashboards`
- `/app/pipelines`
- `/app/api-webhooks` (also pointed at by the API as admin-only)
- `/app/notifications` (reachable only via the header bell)

The module code even acknowledges this in comments (“`/app/sequences` is not
in `NAV_SECTIONS`”, `marketing/page.tsx:17`, `conversation-intelligence/types.ts:11`),
and `docs/INTEGRATION-TODO.md` §3 lists it as “navigation entries nobody owns”.
Build quality is done; discoverability is not.

**Fix:** add entries to `NAV_SECTIONS` (a “Marketing” group and a
“Customer”/“Operations” group, and `/app/settings/api` for api-webhooks per
spec 32 §2). Add an inbound link from Deals → Pipelines and from the
notification bell → Notifications (already present). Add a test that asserts
every concrete `app/app/**/page.tsx` is reachable from `ALL_ROUTES` (or
deliberately allow-listed).

## 7.3 HIGH — `/app/analytics` is a dead nav link to a placeholder

Nav Platform group has `{ href: "/app/analytics", label: "Analytics" }`, which
resolves to the `[section]` catch-all and renders
`ModulePlaceholder` ("Dashboards & Analytics, spec 27") — **even though a real
Dashboard implementation exists at `/app/dashboards`** (spec 27) but is not
linked.

**Fix:** point the nav entry at `/app/dashboards` (and/or add a redirect from
`/app/analytics` → `/app/dashboards`).

## 7.4 MEDIUM — the home Dashboard is still a foundation stub

`apps/web/app/app/dashboard/page.tsx` shows three metric cards with literal
`"—"` values (“Open deals”, “Tasks due”, “New leads (7d)”) and the text
“Pipeline metrics and briefings land in later phases.” It also has no
`loading.tsx`/`error.tsx`. The `/app/dashboards` module (spec 27) is the real
dashboards feature; the landing page users hit first is empty.

**Fix:** replace the stub cards with real aggregates (from the reports/dashboards
services) or redirect `/app/dashboard` to `/app/dashboards`.

## 7.5 MEDIUM — loading/error file coverage is inconsistent

The checklist requires “Loading, empty and error states on every page.” In
practice the list routes almost all ship `loading.tsx`+`error.tsx`, but the
detail and form routes are uneven. Directories with a `page.tsx` but **no**
`loading.tsx` and **no** `error.tsx`:

```
app/[section], activities/[id], activities/new, automation/[id], automation/new,
automation/runs, booking-links/new, calendar/agenda, calendar/new, calling/new,
companies/new, custom-objects/[slug]/records/new, customer-success/new,
dashboard, deals/[id], email/new, files/[id], forms/[id], import-export/[id],
invoices/new, knowledge-base/[id], knowledge-base/new, leads/[id],
marketing/campaigns/new, marketing/segments/new, people/new, pipelines/[id],
products/[id], quotes/new, reports/new, sequences/new, tasks/[id], tickets/new,
whatsapp/new, login, signup, unsubscribe, portal/{invoices,login,quotes,tickets,tickets/[id],verify}
```

All of these are **client components** that handle loading/empty/error inline
with `Skeleton`/`ErrorState`, so the practical user experience is fine. The
finding is inconsistency: e.g. `people/[id]` and `companies/[id]` ship
`loading.tsx`+`error.tsx`, while the structurally identical `deals/[id]`,
`leads/[id]`, `tasks/[id]` and `products/[id]` do not. Two different patterns
for the same job invite drift — and when a client page ships its own
`loading.tsx`, that Suspense fallback is usually dead code anyway.

**Fix:** pick one pattern. Either (a) standardize on inline states for client
pages and delete the redundant `loading.tsx`/`error.tsx` files, or (b) add the
files consistently. Document the choice in `docs/conventions.md`.

## 7.6 MEDIUM — app-shell controls are non-functional or inaccessible

`apps/web/components/app-shell.tsx`:

- **`+ Create` button has no handler** (line ~78: `<Button size="sm">+ Create</Button>`).
  Clicking does nothing. Either wire it to a create menu or remove it.
- **Workspace switcher is a bare `<button>` with no handler** (title
  "Workspace switcher"). It renders the workspace name and does nothing.
- **Command palette accessibility:** it declares `role="dialog"` but has no
  `aria-modal`, no focus trap, and **no Escape-key handler** — despite the
  footer text “↑↓ navigate · ↵ select · esc close”. The ↑/↓/↵ advertised keys
  are also not implemented (only click and typing filter work). This is a
  keyboard-accessibility bug and a false affordance.

**Fix:** wire or remove the two dead controls; add `Escape` handling,
`aria-modal`, a focus trap, and either implement the arrow-key navigation or
change the footer hint.

## 7.7 MEDIUM — no unauthenticated redirect

There is no route guard and no middleware redirect. An unauthenticated user
who opens `/app/people` gets the shell plus whatever 401 error state the page
renders — not a redirect to `/login`. `SessionFooter` does surface
“Not signed in · Log in”, which mitigates it, but every page independently
handles/reports 401s.

**Fix:** add a small client guard (or Next middleware) that redirects to
`/login?next=…` on 401, and have `apiFetch` surface a typed 401 so pages can
share one handler.

## 7.8 LOW — the public surface has no `loading`/`error` for `/login`, `/signup`, `/unsubscribe`

Minor polish: the auth and unsubscribe pages lack suspense/error files. They
are forms with inline error handling, so impact is low; grouped here for
completeness with 7.5.

## 7.9 ✅ Verified — page quality is otherwise high

- List pages consistently provide empty states with a clear next action,
  search, filters, saved views, pagination and bulk actions.
- Every implemented list/detail page avoids `dangerouslySetInnerHTML`
  (verified repo-wide — email, knowledge-base and WhatsApp detail pages state
  this explicitly and render text nodes instead).
- Error boundaries (`error.tsx`) consistently log with `console.error` and
  offer a retry.
- Mobile: the sidebar is `hidden md:flex` with a `MobileNav` drawer and an
  `OfflineBanner`; `packages/ui`'s `DataTable` uses `min-w-max` so wide tables
  scroll rather than break on small screens.

## Summary

| # | Severity | Item |
| --- | --- | --- |
| 7.1 | INFO | Full route inventory (all implemented modules have concrete pages) |
| 7.2 | HIGH | 8+ built modules unreachable from nav |
| 7.3 | HIGH | `/app/analytics` nav link → placeholder; real `/app/dashboards` unlinked |
| 7.4 | MEDIUM | Home dashboard is a stub with “—” metrics |
| 7.5 | MEDIUM | Inconsistent `loading.tsx`/`error.tsx` coverage on detail/form routes |
| 7.6 | MEDIUM | Dead `+ Create` / workspace-switcher controls; command-palette a11y gaps |
| 7.7 | MEDIUM | No unauthenticated redirect to `/login` |
| 7.8 | LOW | Public auth/unsubscribe pages lack loading/error files |
| 7.9 | INFO | Page-level quality otherwise consistently high |
