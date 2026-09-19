# Wave 1 — Docker & Deployment Agent

Branch: `agent/docker-deploy`

A core product principle is "self-hostable with a one-command Docker Compose
path." The root `Dockerfile` builds only the API, there is no `.dockerignore`
(so builds copy `node_modules` and `.next` into context), and there is no
production compose file.

Specs: `docs/yourcrm-agent-spec-pack/00-project-initialization.md`,
`docs/yourcrm-stack.md` §13 Deployment

## You own, exclusively

```text
Dockerfile
.dockerignore                 (new)
docker-compose.yml
docker-compose.prod.yml       (new)
infrastructure/docker/**      (new)
infrastructure/README.md
```

Do **not** touch `.github/**` (the CI agent owns it), `scripts/`,
`package.json`, `.env`, `.env.example`, or any source file.

## Build

1. **`.dockerignore`** — exclude `node_modules`, `.next`, `dist`, `.turbo`,
   `.git`, `test-results`, `playwright-report`, `pgdata`, `minio-data`, `.env`.
   Measure and report the build-context size before and after.
2. **Multi-stage `Dockerfile`** producing a separate runnable image per app:
   api, web, worker, mcp. Use a shared dependency stage so the Bun install
   layer is cached once. Run as a non-root user. No secrets baked in.
   Include a `HEALTHCHECK` for api and web.
3. **`docker-compose.prod.yml`** — the four apps plus Postgres, Redis and
   MinIO, wired by service name, reading config from the environment. Named
   volumes for Postgres and MinIO. Restart policies. This is the file a
   self-hoster runs.
4. Keep the existing dev `docker-compose.yml` working exactly as documented —
   **host port 5442 for Postgres is deliberate** (it avoids clashing with
   other local projects) and `docs/getting-started.md` documents it. Do not
   "fix" it to 5432.
5. Rewrite `infrastructure/README.md` to describe what now exists. K8s and
   Terraform remain explicitly out of scope — do not add them.

## Verify before reporting

You must actually build the images, not just write the files:

```bash
docker build --target api -t yourcrm-api:test .
docker compose -f docker-compose.prod.yml config
```

Report real image sizes. If a build fails, fix it or report it — do not
report success on an unbuilt Dockerfile.
