# Observability

Application-level observability for YourCRM. The code (health/readiness/metrics
routes) lives in `apps/api/src/routes/health.ts`; this directory holds the
operator-side config that consumes it.

## Contents

| File                     | Purpose                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `prometheus.yml`         | Scrape-job example for a self-hosted Prometheus.            |
| `rules.yml`              | Alert-rule examples (error rate, latency, dependency down). |
| `grafana-dashboard.json` | Minimal dashboard (traffic, errors, latency, dependencies). |

## Endpoints (served by the API)

- `GET /health` — cheap liveness probe. Touches **no** dependency; always
  `200` with `{ status: "ok", version, requestId, checks, time }`.
- `GET /ready` — readiness probe. Checks Postgres, Redis and S3/MinIO with a
  2s per-check timeout and reports per-dependency status plus BullMQ queue
  depths. Always `200`; `status` is `"ok"` or `"degraded"` — it degrades
  instead of throwing.
- `GET /metrics` — Prometheus text exposition. **Disabled by default**; set
  `METRICS_ENABLED=1` to expose it, and only on an internal listener or
  behind auth/proxy rules.

Full contract, log-field glossary and triage steps: `docs/operations.md`.
