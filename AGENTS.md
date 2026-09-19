# YourCRM Agent Instructions

Product specifications in the spec pack (`00-*` … `50-*`,
`DATA-MODEL-CONTRACTS.md`, `EVENTS-AND-INTEGRATIONS.md`, `MASTER-ROADMAP.md`)
are the source of truth for feature scope. This repo is the foundation they
build on.

## Before coding

1. Read this file, `README.md`, `docs/architecture.md`, `docs/conventions.md`.
2. Read your assigned module spec + its dependencies.
3. Inspect existing shared contracts (`packages/*/src`) before adding code.

## Hard rules

- **Layering**: Hono route -> validation -> permission check -> domain
  service (`@yourcrm/crm`) -> repository (`@yourcrm/database`) -> Postgres.
  No business logic in route handlers. No SQL outside `packages/database`.
- **No duplicate foundations**: reuse auth, permissions, UI primitives, API
  envelopes, event bus. If a contract is missing, document the gap — don't
  silently invent a parallel one.
- **Permissions server-side**: every service method calls
  `requirePermission()`; AI/MCP actions inherit caller permissions.
- **Events + audit**: emit `<domain>.<entity>.<verb>` events and write audit
  rows for important mutations. Consumers must be idempotent.
- **Migrations**: additive, reversible where practical, transaction-safe.
  Follow `packages/database/migrations/0001_foundation.sql` conventions.
- **Tests with every feature**: unit + API/integration; Playwright for
  primary workflows. Loading, empty and error states on every page.
- **Scope**: P0 first. Don't build a full ERP, don't invent features outside
  your module, don't modify product requirements.

## Boundaries (import direction)

```text
apps/* -> @yourcrm/crm, @yourcrm/ai, ... (domain)
         -> @yourcrm/database, @yourcrm/storage, ... (infra)
         -> @yourcrm/config, @yourcrm/validation, @yourcrm/events, @yourcrm/permissions, @yourcrm/auth
```

`@yourcrm/crm` must not import Hono, Next.js, or `@yourcrm/ui`.
`@yourcrm/ai` consumes domain services, never tables. MCP tools consume
domain services, never tables.

## Completion checklist (per module)

- [ ] UI routes implemented (concrete `page.tsx` replaces placeholder)
- [ ] API routes + zod schemas + OpenAPI entries
- [ ] DB migration + repository methods
- [ ] Permissions enforced + tests proving denial
- [ ] Events emitted + audit rows
- [ ] Search/filter/bulk + pagination envelopes
- [ ] Loading/empty/error states, mobile-usable
- [ ] Seed/example data where useful
- [ ] Docs updated (package README if contracts changed)
