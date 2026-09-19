# Operations runbook

Who this is for: whoever runs a YourCRM deployment (self-hosted or cloud).
It covers health endpoints, logs, correlation IDs, backups/restores, and
where to start when something is broken.

## 1. Health endpoints

| Endpoint       | Purpose                                                                                                           | Auth | Default                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------- |
| `GET /health`  | Cheap **liveness** probe. Touches no dependency. Always `200`.                                                    | none | on                                     |
| `GET /ready`   | **Readiness** probe. Checks Postgres, Redis, S3/MinIO + queues. Always `200` with `status: "ok"` or `"degraded"`. | none | on                                     |
| `GET /metrics` | Prometheus text exposition.                                                                                       | none | **off** — requires `METRICS_ENABLED=1` |

### Liveness: `/health`

For load balancers and uptime monitors. It answers even during a full
outage, so a `200` here means "the process is alive", nothing more.

```jsonc
{
  "status": "ok", // always "ok" — liveness never degrades
  "version": "0.1.0",
  "requestId": "7f99e183-…",
  "checks": {
    "database": { "ok": true, "note": "liveness only — live dependency status at /ready" },
    "redis": { "ok": true, "note": "liveness only — live dependency status at /ready" },
    "storage": { "ok": true, "note": "liveness only — live dependency status at /ready" },
    "worker": { "ok": true, "note": "see apps/worker" },
  },
  "time": "2026-09-19T14:35:54.726Z",
}
```

The shape (`status`, `version`, `requestId`, `checks`, `time`) is stable:
`docs/getting-started.md` and the web app's API status card read it.

### Readiness: `/ready`

For deploy gates and "is it healthy?" questions. Each dependency is checked
in parallel with a 2s timeout; failures are reported per dependency, never
thrown — the endpoint degrades (`"status": "degraded"`, still HTTP 200)
instead of 500ing.

```jsonc
{
  "status": "degraded",
  "checks": {
    "database": { "ok": true, "latencyMs": 30 },
    "redis": { "ok": false, "error": "timeout" }, // "timeout" | "unreachable" only
    "storage": { "ok": true, "latencyMs": 16 },
    "worker": { "ok": true, "note": "see apps/worker" },
    "queues": { "ok": true, "depth": { "yourcrm-default": 0, "...": 0 } },
  },
}
```

Error strings are deliberately generic (`timeout` / `unreachable`) — failure
details never include connection strings or credentials.

Known limits (documented, not hidden):

- `storage` proves configuration/credentials via a presign, not a live
  bucket round-trip (`StorageService.healthcheck()` performs no network
  I/O). A real `HeadBucket` check belongs in `@yourcrm/storage`.
- `worker` is a static pointer: worker health is observed via worker logs
  (`worker_started` / `worker_redis_ready`) and queue depths, not via HTTP.
- `queues.depth` reads BullMQ Redis keys best-effort; if it fails while
  Redis is up, `/ready` still reports `redis.ok: true` with `queues.ok: false`.

### Metrics: `/metrics`

Hand-rolled Prometheus exposition (no new dependencies). Exposed:

- `yourcrm_http_requests_total{method,route,status}` — request count.
- `yourcrm_http_request_duration_ms_{bucket,sum,count}{method,route,status}` —
  duration histogram (buckets 5ms…5s).
- `yourcrm_dependency_up{name}` / `yourcrm_dependency_latency_ms{name}` —
  last `/ready` result per dependency.
- `yourcrm_queue_depth{queue}` — waiting+active BullMQ jobs per queue.
- `yourcrm_process_uptime_seconds`, `yourcrm_process_memory_bytes{kind}`.
- `yourcrm_db_pool_max_connections` — static (10), mirrors the pool size in
  `packages/database/src/client.ts`.

Gating: `/metrics` answers `404` unless `METRICS_ENABLED=1|true|yes`.
Keep it that way in production — scrape over a private network or behind
your proxy's access rules, never the public internet. Scrape/alert examples:
`infrastructure/observability/prometheus.yml`, `rules.yml`, and a starter
`grafana-dashboard.json`.

## 2. Logs

HTTP access logs are structured JSON, one line per request, emitted by
`apps/api/src/middleware/logger.ts` (do not redesign it; build on it):

```jsonc
{
  "level": "info",
  "msg": "http_request",
  "method": "GET",
  "path": "/ready",
  "status": 200,
  "durationMs": 30,
  "requestId": "2bcacd9a-…",
}
```

| Field             | Meaning                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `level`           | `info` for requests; `error` for `unhandled_error` / `redis_error`                                   |
| `msg`             | Event name: `http_request`, `unhandled_error`, `redis_error`, `worker_started`, `worker_redis_ready` |
| `method` / `path` | What was called (path is the raw path, no query string)                                              |
| `status`          | HTTP status returned                                                                                 |
| `durationMs`      | Wall time spent handling the request                                                                 |
| `requestId`       | Correlation ID for this request (see §3)                                                             |
| `err`             | Stringified error (error events only; never secrets)                                                 |

Rules: never log secrets, tokens, passwords, or full request bodies.
`requestId` is safe to log (random UUID, no PII).

## 3. Correlation IDs end to end

1. The client generates (or forwards) `x-request-id`; the web client does
   this for every call (`apps/web/lib/api-client.ts`).
2. The API echoes it back as the `x-request-id` response header
   (`apps/api/src/middleware/request-id.ts`) and includes it as `requestId`
   in health envelopes and error envelopes.
3. Every log line for the request carries the same `requestId`.
4. Domain writes store it as `correlation_id` on audit rows; domain events
   carry it as `correlationId` (`@yourcrm/events` envelope).

Tracing one user report: take the `x-request-id` response header (or the
`requestId` in the error body) → `grep '"requestId":"<id>"'` across API and
worker logs → join to audit rows / events on `correlation_id`.

## 4. Backup and restore

Scripts: `infrastructure/backup/` (details + scheduling in its `README.md`).

- `backup-postgres.sh` — `pg_dump -Fc` → `$BACKUP_DIR/postgres/`, prunes
  older than `RETENTION_DAYS` (default 14), optional GPG via `GPG_RECIPIENT`.
- `backup-storage.sh` — `mc mirror` bucket → `$BACKUP_DIR/storage/<bucket>/`.
- `restore-postgres.sh <dump> <target-url>` and
  `restore-storage.sh <backup-dir> <target-bucket>` — restore **into scratch
  targets only** (name must contain `test`, `scratch` or `restore`) unless
  `RESTORE_LIVE=1` is set, with a 5s abort window for live restores.

### Tested restore procedure (last verified 2026-09-19, local compose stack)

1. `export DATABASE_URL=… BACKUP_DIR=/tmp/opencode/yourcrm-backup-test`
2. `./infrastructure/backup/backup-postgres.sh` → 20K dump, 8 tables.
3. `./infrastructure/backup/restore-postgres.sh <dump> …/yourcrm_restore_test`
   → exit 0, `OK: restored; public schema holds 8 table(s), all dump tables
verified`. Row counts identical source vs. restored (users 2, workspaces
   1, memberships 2, sessions 2, credentials 2, audit_events/notifications 0).
4. Storage: seeded 2 scratch objects → `backup-storage.sh` → restored into
   `yourcrm-restore-test` → `mc diff` empty, file contents identical.
5. Scratch database, buckets and temp files removed afterwards.

Notes from that run (kept, not hidden):

- Local `pg_dump/pg_restore` v18 against server PG16 emits one benign
  `SET transaction_timeout` error; the restore script tolerates warning-only
  `pg_restore` exits and judges success by verifying every dumped table
  exists in the target.
- The `mc` container image's entrypoint is `mc` itself — the scripts use
  `--entrypoint sh`. Bucket names must be DNS-style (hyphens, no
  underscores).

## 5. "It's broken, start here"

1. `GET /health` — no `200`? The API process is down: check the process /
   container, then its startup logs (env validation fails fast on bad config).
2. `GET /ready` — which check is `ok: false`?
   - `database`: is Postgres up? `docker compose ps`; can you `psql` with
     `DATABASE_URL`? Recent migration failure? (see migrate logs).
   - `redis`: is Redis up? `redis-cli -u $REDIS_URL ping`.
   - `storage`: endpoint reachable? credentials valid? (Remembers §1: this
     check is config-level, not a round-trip.)
   - `queues.depth` growing while workers idle: worker down — check worker
     logs for `worker_redis_ready`; dead-lettered jobs need inspection.
3. Correlate: pull the failing request's `requestId` (§3) and follow it
   through logs → audit rows.
4. Metrics (if enabled): error-rate / p95-latency alerts in
   `infrastructure/observability/rules.yml` point at the offending route.
5. Data loss suspected: **stop writes first**, then restore to a scratch
   target and verify (§4) before even thinking about `RESTORE_LIVE=1`.
