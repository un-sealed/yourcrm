# `@yourcrm/database`

Shared database access layer — the ONLY place postgres connections are created.

- `src/client.ts` — `getDb()` singleton / `closeDb()`. Apps and domain
  services import this; never call `postgres()` elsewhere.
- `src/schema/` — Drizzle table definitions. `base.ts` holds the
  `BaseRecord` column contract every business table spreads in.
- `src/repositories/` — `createBaseRepository()` gives domain repos
  workspace scoping, soft-delete filtering and cursor pagination.
- `migrations/*.sql` — applied in order by `src/migrate.ts`
  (`bun run db:migrate`). Transaction-safe, recorded in `schema_migrations`.
- `src/seed.ts` — deterministic demo data (`bun run db:seed`,
  `SEED_RESET=1` removes it).
- `drizzle.config.ts` — `bun run db:generate` (drizzle-kit) for later agents.

pgvector / pg_trgm are enabled in `0000_extensions.sql` for future AI
retrieval and fuzzy search. Domain tables (people, companies, leads, …)
are added by module agents following the `0001_foundation.sql` pattern.
