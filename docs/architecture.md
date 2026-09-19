# Architecture

Source specs: `01-architecture`, `03-data-model`, `DATA-MODEL-CONTRACTS.md`,
`EVENTS-AND-INTEGRATIONS.md`. This page records how the foundation maps
them to code.

## Request path

```text
HTTP Request
  -> Hono Route (apps/api/src/routes/*)
  -> Middleware (request-id, logger, auth)
  -> Validation (zod at the boundary, @hono/zod-validator)
  -> Permission Check (lib/authorization -> @yourcrm/permissions)
  -> Application / Domain Service (@yourcrm/crm — module agents)
  -> Repository (@yourcrm/database — workspace-scoped, soft-delete aware)
  -> PostgreSQL (+ pgvector/pg_trgm extensions enabled)
```

Hono is a thin HTTP layer. No Nest-like framework on top of it: plain
modules, functions, services, repositories, policies.

## API conventions (spec 01)

- Errors: `{ error: { code, message, requestId?, details? } }`
  (`@yourcrm/validation`). Central handlers in `middleware/errors.ts`.
- Pagination: `{ data, pagination: { nextCursor, limit } }`, cursor-based
  for timelines/high-volume feeds (`LimitOptions` in database package).
- Versioning: URL prefix `/api/v1`; additive `/api/v2`, never mutate shipped.
- Every request carries `x-request-id` (client generates or forwards;
  server echoes). Structured JSON logs include it; audit rows store it as
  `correlation_id`.
- OpenAPI: stub at `/openapi.json` today; Phase 1 generates from route
  zod registries.

## Events (spec 01 + EVENTS-AND-INTEGRATIONS.md)

Envelope (`@yourcrm/events`): eventId, event (`<domain>.<entity>.<verb>`),
timestamp, workspaceId, actorId/actorType, entityType/Id, before/after,
correlationId, schemaVersion. Rules: version schemas, include workspace +
actor, never secrets, idempotent consumers, retry transient, dead-letter
permanent. In-process `EventBus` for domain code/tests; Redis/BullMQ fan-out
is a worker concern.

## Background jobs

BullMQ behind `apps/worker/src/queues.ts` (`getQueue`, `QueueNames`).
Handlers in `src/jobs/*`, registered by name in `src/worker.ts`.
Retryable (5 attempts, exponential backoff), idempotent (pure function of
validated input), observable (JSON logs), dead-lettered after retries.
The queue abstraction is the seam for a future Temporal swap — domain code
never imports BullMQ directly.

## Data

- `BaseRecord` contract: id, workspaceId, createdAt/updatedAt,
  createdBy/updatedBy, deletedAt (soft delete, restorable; hard delete only
  by explicit policy + audit).
- Custom objects/fields engine (spec 03) lands with the data-model agent;
  foundation tables follow the same column conventions so they compose.
- Files: bytes in S3/MinIO (`@yourcrm/storage`), metadata in Postgres.

## Realtime

WebSocket channels (`workspace:<id>` for notifications/record updates) land
with the notifications agent; contracts already exist
(`@yourcrm/notifications`, `notifications` table).

## Dependency rules

```text
apps -> domain packages (@yourcrm/crm, ai, agents, workflows, integrations)
     -> infra packages (database, storage, search impl)
     -> base packages (config, validation, events, permissions, auth, notifications, ui)
```

- Domain never imports UI, Hono, or Next.js. Infra details never leak to
  the frontend (web talks to the API via `lib/api-client.ts` only).
- AI and MCP consume domain service interfaces, never repositories/tables.

Verified by `bun run typecheck` (no cycles possible without imports) plus
the import-direction review checklist in `AGENTS.md`.
