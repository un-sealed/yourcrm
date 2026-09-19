# `@yourcrm/worker` — BullMQ background jobs (Bun runtime)

- `src/index.ts` — bootstrap: env validation, Redis connect, graceful
  shutdown (SIGTERM/SIGINT drain).
- `src/redis.ts` — shared Redis connection (only place one is created).
- `src/queues.ts` — queue abstraction + `QueueNames`. Domain code enqueues
  here; never constructs BullMQ primitives directly (Temporal path).
- `src/worker.ts` — job registration (`JobHandlers` by name), concurrency
  - rate limits, failure logging / dead-letter via attempts+backoff.
- `src/jobs/example.ts` — `example.ping` proving the loop works.

Verify manually: start Redis (`bun run docker` infra), `bun run dev`,
enqueue `example.ping` — see `job_completed` in logs.
