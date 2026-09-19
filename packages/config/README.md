# `@yourcrm/config`

Single source of truth for environment configuration.

- `packages/config/src/env.ts` — zod schema + `loadEnv()` / `requireEnv()`.
- Every app (`api`, `worker`, `mcp`, `web` server code) must call
  `requireEnv()` at startup and fail fast on invalid config.
- Never commit real credentials; copy `.env.example` to `.env`.
