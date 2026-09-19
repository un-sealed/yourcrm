# Wave 1 — Observability & Backups Agent

Branch: `agent/observability`

Spec: `docs/yourcrm-agent-spec-pack/50-observability-backups.md`

Self-hosters need to know the system is healthy and to get their data back
when it is not. Today there is a single `/health` endpoint and no backup path
at all.

## You own, exclusively

```text
apps/api/src/routes/health.ts
infrastructure/observability/**   (new)
infrastructure/backup/**          (new)
docs/operations.md                (new)
```

Do **not** touch `apps/api/src/routes/v1.ts` or `apps/api/src/routes/modules/`
(the platform-seams agent owns those right now), `scripts/` (also theirs),
`.github/**` (CI agent), `Dockerfile` or `docker-compose*.yml` (docker agent),
or `package.json`.

## Build

1. **Health split** — keep `/health` as a cheap liveness probe that touches no
   dependency, and add `/ready` as a readiness probe that checks Postgres,
   Redis and S3/MinIO with a short timeout, reporting per-dependency status
   and degrading rather than throwing. Preserve the existing `/health`
   response shape — `docs/getting-started.md` and the web app's status card
   both depend on it.
2. **Metrics** — a Prometheus-format `/metrics` endpoint: request count and
   duration by route and status, queue depth, DB pool stats. Do not add a
   dependency; a small hand-rolled registry is fine and expected here.
3. **Backup and restore** — `infrastructure/backup/` scripts for `pg_dump`
   and MinIO bucket sync, plus a **restore** script. Document a tested
   restore procedure in `docs/operations.md`. A backup nobody has restored is
   not a backup — actually run your restore against a scratch database and
   report the result.
4. **Operations runbook** — `docs/operations.md`: health endpoints, what each
   log field means, how to read a correlation ID end to end, backup/restore,
   and a short "it's broken, start here" triage section.

## Rules

- Structured JSON logging already exists in `apps/api/src/middleware/logger.ts`
  and carries `requestId`. Do not redesign it and do not edit that file —
  document the existing contract and build on it.
- Never log secrets, tokens, passwords or full request bodies.
- `/metrics` must not be publicly exposed by default; gate it behind a config
  flag and say so in the runbook.
