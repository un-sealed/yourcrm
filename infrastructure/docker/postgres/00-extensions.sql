-- YourCRM — Postgres initialization for production compose.
-- Mounted read-only into /docker-entrypoint-initdb.d (see
-- docker-compose.prod.yml). Runs once, on first volume creation.
-- Enables the extensions the data layer expects (architecture: pgvector
-- for AI retrieval, pg_trgm for fuzzy/name matching). Drizzle migrations
-- own all tables — this file creates no tables.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
