# Wave 1 — Platform Seams Agent

Branch: `agent/platform-seams`

You build the shared seams that let eleven module agents work in parallel
without editing the same files. Every seam you fail to build becomes eleven
merge conflicts.

Specs: `docs/yourcrm-agent-spec-pack/01-architecture.md`,
`docs/yourcrm-agent-spec-pack/EVENTS-AND-INTEGRATIONS.md`

## You own, exclusively

```text
packages/events/**
packages/database/src/audit.ts            (new)
packages/database/src/repositories/index.ts
packages/database/src/index.ts
apps/api/src/routes/v1.ts
apps/api/src/routes/modules/            (new directory)
apps/api/src/openapi/                   (new directory, if needed)
scripts/                                (new directory, if needed)
```

Do **not** touch `packages/ui`, `packages/auth`, `packages/crm`,
`packages/database/src/schema/**`, or any `apps/web` file.

## Tasks

### 1. Audit helper
`writeAudit()` in `packages/database/src/audit.ts`, exported from the package.
`AGENTS.md` mandates an audit row per important mutation and the
`audit_events` table already exists — there is no helper today.

Signature must cover the DATA-MODEL-CONTRACTS.md audit contract: workspace,
actor, action, object, recordId, before/after, correlationId, and
`source` in `user | automation | ai | integration | mcp`.
Accept an optional transaction handle so callers can write the audit row in
the same transaction as the mutation. Unit-test it.

### 2. API module registry
Today every module agent would have to edit `apps/api/src/routes/v1.ts` to
mount its router — eleven agents, one file, guaranteed conflict.

Build a registry so they never touch it:
- module routers live at `apps/api/src/routes/modules/<slug>.ts`
- each exports a factory returning a `Hono<AppEnv>` sub-app, plus its base path
- `v1.ts` imports and mounts them from **one** list, or discovers them
- **Bun does not support reliable filesystem globbing at runtime in a built
  bundle.** Prefer a generated manifest: a `scripts/gen-routes.ts` that writes
  `apps/api/src/routes/modules/index.ts` from the directory listing, wired to a
  `bun run gen:routes` script. Explicit and debuggable beats clever.
- Port the existing `/ping`, `/echo` and `/me` handlers into the new shape as
  the worked example, keeping their current paths and behavior identical.
- Add an API test proving a module router mounts at its prefix.

### 3. Event constants
`packages/events/src/envelope.ts` declares the CRM and communication events
but is missing everything Wave 2 needs. Add, in the existing style:

```text
pipeline.created  pipeline.updated  pipeline.stage_reordered
product.created   product.updated   product.archived
form.created      form.updated      form.submitted
file.uploaded     file.deleted
import.started    import.completed  export.completed
person.deleted    company.deleted   lead.deleted   deal.deleted
activity.deleted  task.deleted      product.deleted
```
Module agents are forbidden from adding event constants, so anything you miss
becomes a blocked agent.

### 4. Barrel generation
`packages/crm/src/index.ts` and `packages/database/src/schema/index.ts` are
edited by every module agent — eleven conflicts on two files.

`packages/database/src/schema/index.ts` is **not yours to edit** (the
shared-tables agent owns it this wave). Instead add a `scripts/gen-barrels.ts`
that regenerates both barrels from their directory contents, plus a
`bun run gen:barrels` script, and document it. The integrator runs it after
each merge instead of hand-resolving conflicts.

### 5. OpenAPI
`/openapi.json` is a stub. Make it assemble from the registered module routers
so each module contributes its own paths. Keep it simple — a zod-to-JSON-schema
pass over route schemas is enough. Do not add a dependency for this.
