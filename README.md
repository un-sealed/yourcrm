# YourCRM

AI-native, self-hostable open-source CRM. Bun + Turborepo monorepo:
TypeScript end to end, Hono API, Next.js web, BullMQ workers, MCP server.

> Phase 0 foundation. Individual CRM modules (People, Companies, Leads,
> Deals, …) are implemented by later agents against the contracts below.
> Do not add business features to the foundation packages.

## Repository structure

```text
apps/
  web/        Next.js app shell (Tailwind + shadcn-style tokens, TanStack Query, Zustand)
  api/        Hono HTTP layer (thin: routes -> validation -> permissions -> services)
  worker/     BullMQ background jobs (Bun runtime)
  mcp/        MCP server (stdio foundation, tool registration pattern)
  mobile/     Expo placeholder (Phase 4)

packages/
  config/       env schema + validation at startup
  validation/   API envelopes, pagination, BaseRecord contract
  database/     Drizzle ORM, migrations, seed, repositories (ONLY db access)
  auth/         session contract + integration point
  permissions/  workspace -> object -> record -> field -> action policies
  events/       domain-event envelope + bus + event name constants
  storage/      S3-compatible object storage (MinIO locally)
  notifications/ notification contracts + queue helper
  search/       search abstraction (Postgres FTS first, swap later)
  ui/           shared primitives (shadcn/ui conventions)
  crm/          domain-service boundary (module agents build here)
  ai/ agents/ workflows/ integrations/   Phase 2-3 boundaries (placeholders)

infrastructure/  docker-compose notes (K8s/Terraform out of scope for now)
docs/            getting-started, architecture, conventions
```

## Prerequisites

- Bun ≥ 1.1 (`curl -fsSL https://bun.sh/install | bash`)
- Docker (for PostgreSQL + Redis + MinIO)

## Quickstart

```bash
cp .env.example .env
docker compose up -d            # postgres :5442, redis :6379, minio :9000/:9001
bun install
bun run db:migrate
bun run db:seed                 # demo workspace + 2 users (optional, removable)
bun run dev                     # api :4000, web :3000, worker, mcp (via turbo)
```

Verify: `curl localhost:4000/health` → `{"status":"ok",...}`; open
`http://localhost:3000` — the API status card should read `ok`.

## Scripts (root, via Turborepo)

| Command                                  | What it does                                         |
| ---------------------------------------- | ---------------------------------------------------- |
| `bun run dev`                            | `turbo run dev` — all apps in watch mode             |
| `bun run build`                          | `turbo run build` — all apps + dependent packages    |
| `bun run test`                           | `turbo run test` — `bun test` per workspace          |
| `bun --filter @yourcrm/web run test:e2e` | Playwright smoke suite vs live web + API servers     |
| `bun run lint`                           | `turbo run lint` — eslint per workspace              |
| `bun run typecheck`                      | `turbo run typecheck` — `tsc --noEmit` per workspace |
| `bun run format` / `format:check`        | prettier write / check                               |
| `bun run db:migrate`                     | apply `packages/database/migrations/*.sql`           |
| `bun run db:generate`                    | drizzle-kit generate from `src/schema`               |
| `bun run db:seed`                        | deterministic demo data (`SEED_RESET=1` removes it)  |

Per-workspace: `bun --filter <name> run <script>` (e.g.
`bun --filter @yourcrm/api run dev`).

## Environment

Copy `.env.example` → `.env`. Every app validates env at startup via
`@yourcrm/config` and refuses to boot on invalid config. Never commit
real credentials. Local ports avoid clashes: PostgreSQL maps host
**5442**, Redis **6379**, MinIO **9000** (API) / **9001** (console).

## Architecture (summary)

```text
HTTP Request -> Hono Route -> Middleware -> Validation (zod)
  -> Permission Check -> Domain Service (@yourcrm/crm)
  -> Repository (@yourcrm/database) -> PostgreSQL
```

- Business logic never lives in route handlers; Hono stays thin.
- Domain packages depend on infra packages, never the reverse; no UI
  imports in domain code; no Hono imports outside `apps/api`.
- Events (`<domain>.<entity>.<verb>`) + audit rows on every mutation.
- Jobs are retryable/idempotent/observable (BullMQ, abstraction kept for
  a future Temporal swap). Files live in S3/MinIO, metadata in Postgres.
- Search starts as Postgres FTS behind `SearchProvider`.

Details: `docs/architecture.md`. Agent rules: `AGENTS.md`.
