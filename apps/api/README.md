# `@yourcrm/api` — Hono HTTP layer (thin)

Layering (enforced): route -> middleware -> validation -> permission check
-> domain service (`@yourcrm/crm`) -> repository -> PostgreSQL. No business
logic in handlers.

- `src/index.ts` — Bun.serve bootstrap, env validated at startup.
- `src/app.ts` — `createApp()` composition (used by tests too).
- `src/middleware/` — request-id, structured logger, auth integration
  point (`x-dev-session: 1` in non-production), error envelopes.
- `src/routes/health.ts` — liveness + dependency checks (always 200 when
  alive; `status: ok | degraded`).
- `src/routes/v1.ts` — URL-prefix versioning (`/api/v1`, additive `/v2`).
- `src/routes/openapi.ts` — OpenAPI stub; Phase 1 generates from routes.
- `src/lib/authorization.ts` — route-level permission helper.
