# infrastructure

## Docker (this is the whole story for Phase 0)

| File                                | Purpose                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root `Dockerfile`                   | Multi-stage build: one runnable image per app (`api`, `web`, `worker`, `mcp`) off a single shared Bun-install layer. Non-root runtime, `HEALTHCHECK` on `api` + `web`, no secrets baked in. |
| Root `.dockerignore`                | Keeps `node_modules`, build output, local data and `.env` out of the build context.                                                                                                         |
| Root `docker-compose.yml`           | **Development**: Postgres (host `5442` — deliberate, avoids clashing with other local projects), Redis, MinIO. See `docs/getting-started.md`.                                               |
| Root `docker-compose.prod.yml`      | **Self-host / production**: the four apps plus Postgres, Redis, MinIO, wired by service name, config from the environment, named volumes (`pgdata`, `minimodata`), restart policies.        |
| `docker/postgres/00-extensions.sql` | Enables `vector` + `pg_trgm` on first volume creation (mounted into `/docker-entrypoint-initdb.d`). Tables remain owned by Drizzle migrations.                                              |

## Self-host quickstart

```bash
cp .env.example .env
# Generate real secrets — never ship the placeholder values:
openssl rand -hex 32   # -> SESSION_SECRET
openssl rand -hex 32   # -> ENCRYPTION_KEY
# Optional: change POSTGRES_PASSWORD / MINIO_ROOT_USER / MINIO_ROOT_PASSWORD
# (compose defaults apply when unset; DATABASE_URL/REDIS_URL/STORAGE_* are
# derived from these automatically).

docker compose -f docker-compose.prod.yml up -d --build

# Run migrations + optional demo seed against the prod database:
docker compose -f docker-compose.prod.yml run --rm api \
  bun run /app/packages/database/src/migrate.ts
docker compose -f docker-compose.prod.yml run --rm api \
  bun run /app/packages/database/src/seed.ts   # optional
```

- Web: `http://localhost:3000` (or your `APP_URL`)
- API health: `http://localhost:4000/health` (or your `API_URL/health`)
- MinIO and Postgres/Redis ports are internal-only in prod; reach them via
  `docker compose -f docker-compose.prod.yml exec` when needed.

Rebuild a single app image without touching the rest:

```bash
docker build --target api -t yourcrm-api:latest .
docker compose -f docker-compose.prod.yml up -d api
```

## Explicitly out of scope

Kubernetes (`k8s/`) and Terraform (`terraform/`) are **not** provided — the
stack spec keeps the app fully usable without Kubernetes, and production
orchestration targets land with the CI/CD track in Phase 0b / Phase 1. Do
not add them here.
