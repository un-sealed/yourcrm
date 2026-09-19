# Getting started (local development)

## 1. Prerequisites

- Bun ≥ 1.1 — <https://bun.sh> (`bun --version` ≥ 1.1)
- Docker — for PostgreSQL, Redis, MinIO

## 2. Configure

```bash
cp .env.example .env
# Optional: generate real secrets
openssl rand -hex 32   # -> SESSION_SECRET
openssl rand -hex 32   # -> ENCRYPTION_KEY
```

Key variables (full list in `.env.example`):

| Var                                  | Default                                                 | Purpose                   |
| ------------------------------------ | ------------------------------------------------------- | ------------------------- |
| `DATABASE_URL`                       | `postgres://yourcrm:yourcrm_dev@localhost:5442/yourcrm` | Drizzle + migrate + seed  |
| `REDIS_URL`                          | `redis://localhost:6379`                                | BullMQ + API health check |
| `STORAGE_*`                          | MinIO on `:9000`, bucket `yourcrm`                      | object storage            |
| `APP_URL` / `API_URL`                | `:3000` / `:4000`                                       | web ↔ api wiring         |
| `WEB_PORT` / `API_PORT` / `MCP_PORT` | 3000 / 4000 / 4100                                      | listeners                 |

## 3. Start infrastructure

```bash
docker compose up -d
docker compose ps   # postgres + redis healthy; minio running; minio-init exits 0
```

Ports are offset from defaults on purpose (host `5442` for Postgres) so
they don't clash with other local projects.

## 4. Install + database

```bash
bun install
bun run db:migrate
bun run db:seed            # optional demo data
SEED_RESET=1 bun run db:seed  # remove demo data
```

## 5. Run everything

```bash
bun run dev
```

- Web: <http://localhost:3000> (API status card proves web→API link)
- API: <http://localhost:4000/health>, OpenAPI at `/openapi.json`
- Worker: watch logs for `worker_started` / `worker_redis_ready`
- MCP: `bun --filter @yourcrm/mcp run dev` (stdio transport)

## 6. Quality gates

```bash
bun run typecheck && bun run lint && bun run test && bun run build
```
