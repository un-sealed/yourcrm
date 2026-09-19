-- 0000_extensions: required PostgreSQL extensions.
-- Reversible: DROP EXTENSION IF EXISTS "uuid-osm" ... (down migration notes inline).
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
