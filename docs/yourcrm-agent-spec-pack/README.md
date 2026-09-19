# YourCRM — Agent-Ready Product Specification

Working name: `YourCRM`  
Source basis: `open-source-crm-feature-spec-2026.md` supplied by the product owner.  
Purpose: split the CRM into independently implementable page/module specifications so multiple coding agents can work in parallel.

## How to use this pack

1. Start with `00-project-initialization.md`.
2. Implement foundation contracts before feature agents:
   - `01-architecture.md`
   - `02-design-system.md`
   - `03-data-model.md`
   - `04-authentication.md`
   - `05-users-teams-permissions.md`
3. Each numbered module is intended to be handed to one coding agent.
4. An agent must read its listed dependencies before changing code.
5. Do not duplicate domain logic between modules. Put shared primitives in foundation packages.
6. Every module must expose API contracts, domain events, permissions, loading/error/empty states, tests, and acceptance criteria.
7. P0 features are launch-critical; P1 follows MVP; P2 is later/advanced.

## Product principles

- Zero data entry where automation is possible.
- Fast, keyboard-first interactions.
- Simple by default, powerful when needed.
- Humans remain in control of AI.
- Self-hostable with a one-command Docker Compose path.
- AI-native through MCP and bring-your-own-model support.
- WhatsApp, calling, mobile, migration, SSO and regional workflows are first-class.
- No homemade frameworks; prefer mainstream TypeScript/React/Postgres tooling.
- Basic security and SSO are not artificially paywalled.

## Module rule

A module is not only a list page. Its specification covers:

- list/table/kanban/calendar views where relevant
- record detail and timeline
- create/edit/delete/archive/restore
- duplicate detection and merge
- relationships
- filters, saved views and bulk actions
- import/export
- API/webhooks/events
- permissions and auditability
- automations
- notifications
- AI capabilities
- mobile/PWA behavior
- empty/loading/error/offline states
- tests and acceptance criteria

## Recommended repository shape

```text
apps/
  web/
  api/
  worker/
packages/
  ui/
  db/
  auth/
  permissions/
  search/
  files/
  integrations/
  automation/
  ai/
  mcp/
  sdk/
  config/
  testing/
docs/
  product/
  architecture/
  api/
```

## Agent rules

- Do not silently change shared contracts.
- Prefer additive migrations.
- Use feature flags for incomplete P1/P2 functionality.
- Every write operation should be idempotent where practical.
- Every externally triggered action needs an audit/event trail.
- Never let an AI action bypass normal permissions.
- Add unit tests for domain logic and Playwright tests for critical user flows.
- Keep generated code readable and documented for future coding agents.
