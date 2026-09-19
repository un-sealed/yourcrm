# YourCRM — {{MODULE_TITLE}} Module Agent

You are implementing **exactly one** YourCRM module: **{{MODULE_TITLE}}**.

You are one of several agents working on this repository in parallel, each in
its own git worktree on its own branch. Another agent's work will be merged
alongside yours. Therefore: **stay inside your assigned files**. Touching a
shared file breaks every other agent's merge.

Your branch: `{{BRANCH}}`

---

## 1. Read these first, in this order

1. `AGENTS.md` — hard rules and the completion checklist
2. `docs/architecture.md` — request path, API conventions, dependency rules
3. `docs/conventions.md` — TypeScript, tests, lint/format
4. `docs/yourcrm-agent-spec-pack/{{SPEC_FILE}}` — **your module specification**
5. `docs/yourcrm-agent-spec-pack/DATA-MODEL-CONTRACTS.md`
6. `docs/yourcrm-agent-spec-pack/EVENTS-AND-INTEGRATIONS.md`

Do not read the other module specs. They are not your scope.

---

## 2. The golden reference — mirror it

The **People** module is already implemented end to end and is the reference
implementation. Your job is to produce the same structure for {{MODULE_TITLE}}.

Read all of these before writing any code:

```text
packages/database/src/schema/people.ts
packages/database/migrations/0010_people.sql
packages/database/src/repositories/people-repository.ts
packages/crm/src/people/
apps/api/src/routes/modules/people.ts
apps/web/app/app/people/
```

### Four things People learned the hard way — do not rediscover them

1. **Audit goes through a port, not a direct import.** `packages/crm` may not
   import `@yourcrm/database`, so a service cannot call `writeAudit()`.
   Declare an `AuditWriter` port in your `types.ts`, call `deps.audit({...})`
   in the service, and bind it to the real `writeAudit` in your API route
   file. Copy People's `types.ts` + `service.ts` + route wiring exactly.
2. **Route factories must be side-effect free.** Calling `getDb()` inside
   your `createRoutes()` breaks foundation tests at import time. Lazy-init
   the service inside the handler instead.
3. **Use `@yourcrm/testing`, never hand-rolled fixtures**: `makeSession`,
   `makeServiceContext`, `expectDenied`, `captureEvents`, `createApiClient`,
   `createStore`. Your denial test must use `expectDenied`.
4. **Run `bun run gen:barrels`** after adding your module folder; it now
   handles module directories. Never hand-edit a barrel.

**Mirror its structure, naming, layering, error handling, test style and file
organization.** Where People does something a certain way, do the same thing.
Do not invent a different pattern because you think it is better. Consistency
across modules matters more than local cleverness here.

If your module genuinely needs something People does not have, implement it in
the same style, and note it in your final report under "Deviations".

---

## 3. Scope — P0 only

Implement only the P0 slice:

- List view: table with columns, sorting, pagination, filtering, empty state,
  loading skeleton, recoverable error state
- Detail view: record header, grouped properties, related records, timeline slot
- Create / edit / soft-delete / restore
- Server-side validation (zod at the API boundary)
- Permission checks on every service method
- Domain event + audit row on every mutation
- Unit tests for services, API tests for routes (including a denial test)

{{P0_EXTRA}}

**Explicitly out of scope for you** — later agents handle these. Do not build
them, do not stub them, do not leave TODOs for them:
merge/duplicate-detection, import/export, AI features, automation triggers,
notifications, mobile-specific screens, saved views sharing, webhooks.

---

## 4. Files you MUST CREATE (and only these)

```text
packages/database/src/schema/{{MODULE_SLUG}}.ts
packages/database/migrations/{{MIGRATION_SLOT}}_{{MODULE_SLUG}}.sql
packages/database/src/repositories/{{MODULE_SLUG}}-repository.ts
packages/crm/src/{{MODULE_SLUG}}/index.ts
packages/crm/src/{{MODULE_SLUG}}/service.ts
packages/crm/src/{{MODULE_SLUG}}/service.test.ts
packages/crm/src/{{MODULE_SLUG}}/types.ts
apps/api/src/routes/modules/{{MODULE_SLUG}}.ts
apps/api/src/routes/modules/{{MODULE_SLUG}}.test.ts
apps/web/app/app/{{MODULE_SLUG}}/page.tsx
apps/web/app/app/{{MODULE_SLUG}}/loading.tsx
apps/web/app/app/{{MODULE_SLUG}}/error.tsx
apps/web/app/app/{{MODULE_SLUG}}/[id]/page.tsx
apps/web/app/app/{{MODULE_SLUG}}/_components/   (as needed, module-local only)
```

Creating a new file under a path you own is always safe. Creating a file
anywhere else is not.

## 5. Files you MUST NOT TOUCH

```text
packages/ui/**                          — shared design system, owned elsewhere
packages/database/src/schema/index.ts   — barrel, merged centrally
packages/database/src/schema/base.ts
packages/database/src/schema/core.ts
packages/database/src/repositories/index.ts
packages/database/src/repositories/base-repository.ts
packages/crm/src/index.ts               — barrel, merged centrally
packages/events/**
packages/permissions/**
packages/validation/**
packages/auth/**
packages/config/**
apps/api/src/routes/v1.ts               — module registry, merged centrally
apps/api/src/app.ts
apps/api/src/middleware/**
apps/web/components/nav-sections.ts     — your nav entry already exists
apps/web/app/app/layout.tsx
apps/web/app/app/[section]/page.tsx
bun.lock
package.json  (any of them)
.env / .env.example
any other module's directory
```

If your module cannot be completed without changing one of these, **stop and
report it** (see §9). Do not work around it by duplicating the file.

---

## 6. Your reserved identifiers

Do not use any identifier reserved for another agent.

| Thing | Your value |
| --- | --- |
| Migration slot | `{{MIGRATION_SLOT}}` — file `{{MIGRATION_SLOT}}_{{MODULE_SLUG}}.sql` |
| API route prefix | `{{ROUTE_PREFIX}}` |
| Web route | `{{NAV_HREF}}` (already in `nav-sections.ts`) |
| Permission object | `{{PERMISSION_OBJECT}}` |
| DB tables | {{TABLES}} |
| Domain events | {{EVENT_NAMES}} |

Your routes are mounted by the registry at `apps/api/src/routes/modules/`.
Export a default `{{MODULE_SLUG}}Routes()` factory exactly as
`apps/api/src/routes/modules/people.ts` does — the registry picks it up.
You do not edit the registry.

---

## 7. Hard rules

1. **Never run `bun add`, `bun install <pkg>`, `npm install` or edit any
   `package.json`.** If your module needs a workspace dependency declared
   (e.g. `apps/api` needing your package), **list it in your report under
   Blockers** — People did exactly this and it was the right call. The
   integrator wires it. Do not symlink around it in a way you then commit.
2. **No FK constraints to tables you do not own.** Other modules' tables may
   not exist yet when your migration runs. Reference them as a plain
   `uuid` column with an index, and document the intended relationship in a
   SQL comment. Foreign keys across modules are added in a later integration
   pass.
3. **No business logic in route handlers.** Route = validate → check
   permission → call service → return envelope. Nothing else.
4. **No SQL outside `packages/database`.**
5. `packages/crm` must not import Hono, Next.js, React, or `@yourcrm/ui`.
6. Every service method calls `requirePermission()` **first**, before any read
   or write.
7. Every mutation emits a domain event (`@yourcrm/events`) **and** writes an
   audit row via the injected `AuditWriter` port (see §2.1). Use the exported constant for each
   event name in §6 — never a bare string literal. If a constant you need is
   not exported by `@yourcrm/events`, that is a stop condition (§9): report
   it, do not add it yourself and do not fall back to a literal.
8. All reads are workspace-scoped and soft-delete aware — go through
   `createBaseRepository()`, do not hand-roll queries that skip it.
9. Migrations are additive and transaction-safe. Follow the conventions in
   `packages/database/migrations/0001_foundation.sql`.
10. Use the shared envelopes from `@yourcrm/validation` for every response.
    Errors are `{ error: { code, message, requestId, details? } }`.
11. UI: import primitives from `@yourcrm/ui`. Do not build your own table,
    filter, dialog, or form controls. If a primitive you need is missing,
    stop and report it (§9).
12. Prettier style: no semicolons, 100 columns, trailing commas.

---

## 8. Verification — must pass before you report done

Run these from the repo root and fix everything they surface:

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

`bun run lint` must pass with **zero** warnings.

Then verify your migration applies cleanly on top of the existing ones:

```bash
bun run db:migrate
```

Do not report completion with a failing gate. If you cannot fix a failure,
report it explicitly rather than disabling the rule, casting to `any`, or
deleting the test.

---

## 9. Stop conditions

Stop work and write your report immediately if any of these happen. Do not
improvise around them:

- You need to edit a file in the §5 do-not-touch list
- You need a `@yourcrm/ui` primitive that does not exist
- You need a dependency that is not installed
- Your module spec contradicts `AGENTS.md`, `docs/architecture.md`, or the
  shared contracts
- The People reference module does not exist yet, or does not contain the
  files listed in §2

In each case: describe the gap precisely, say what you would need, and stop.
A clear blocker report is a successful outcome. A silent workaround is not.

---

## 10. Required final report

End your run with exactly these sections, in this order:

```markdown
## Module
{{MODULE_TITLE}} — branch {{BRANCH}}

## Status
COMPLETE | BLOCKED | PARTIAL

## Files created
<one path per line>

## Files modified
<one path per line — should normally be empty>

## Tables and migration
<table names, migration filename>

## Events emitted
<event name -> where it is emitted>

## Permission checks
<service method -> action checked>

## Quality gates
typecheck: PASS/FAIL
lint:      PASS/FAIL
test:      PASS/FAIL  (N passed)
build:     PASS/FAIL
migrate:   PASS/FAIL

## Deviations from the People reference
<what differs and why, or "none">

## Blockers
<what stopped you, or "none">

## Not implemented (deferred by scope)
<list>
```

Do not implement any module other than {{MODULE_TITLE}}.
