-- 0110_search: Global search index (spec 28-search, P0).
-- One denormalized row per indexed record, written by the indexing service
-- in @yourcrm/crm. Postgres full-text only (no pgvector, no embeddings).
-- Follows 0001_foundation.sql conventions (base columns, IF NOT EXISTS,
-- indexes beside the table).
--
-- record_id is a PLAIN uuid column with an index and NO foreign key: the row
-- it points at lives in whichever module table object_type names, and some of
-- those tables are created by later migrations. Migrations apply in filename
-- order, so a foreign key here would break a clean install (same rule as
-- taggables.record_id in 0003_shared_tables.sql and files.subject_id in
-- 0100_files.sql).
--
-- search_vector is GENERATED ALWAYS ... STORED so the repository, a backfill
-- job and psql all produce identical lexemes. The 'simple' configuration is
-- deliberate: CRM titles are proper nouns, and the query side uses prefix
-- matching ('ada:*'), which beats English stemming for a command palette.
--
-- owner_id + visibility carry the record-level permission facts the query
-- needs so denied rows are filtered inside SQL, before pagination.
--
-- Down migration: DROP TABLE IF EXISTS search_index.

CREATE TABLE IF NOT EXISTS search_index (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  object_type VARCHAR(64) NOT NULL,
  -- Polymorphic pointer: plain column, NO foreign key (see header).
  record_id UUID NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  body TEXT,
  visibility VARCHAR(16) NOT NULL DEFAULT 'workspace',
  record_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(subtitle, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(body, '')), 'C')
  ) STORED
);

CREATE INDEX IF NOT EXISTS search_index_workspace_idx ON search_index (workspace_id);
CREATE INDEX IF NOT EXISTS search_index_object_idx ON search_index (workspace_id, object_type);
CREATE INDEX IF NOT EXISTS search_index_owner_idx ON search_index (workspace_id, owner_id);
CREATE INDEX IF NOT EXISTS search_index_record_idx ON search_index (record_id);
CREATE INDEX IF NOT EXISTS search_index_updated_idx ON search_index (workspace_id, record_updated_at);

-- Upsert target for "index this record again". Full (not partial) on purpose:
-- re-indexing a soft-deleted row revives it instead of duplicating it.
CREATE UNIQUE INDEX IF NOT EXISTS search_index_record_uidx
  ON search_index (workspace_id, object_type, record_id);

CREATE INDEX IF NOT EXISTS search_index_vector_gin_idx
  ON search_index USING GIN (search_vector);
