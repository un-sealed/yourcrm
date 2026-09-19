-- 0003_shared_tables: cross-cutting tables referenced by nearly every module
-- spec's data model (tags, relationships, custom fields, saved views).
-- Polymorphic references (object_type/record_id, source/target pairs) are
-- PLAIN columns, never foreign keys: the tables they point at (people,
-- deals, ...) do not exist yet and are created by later module agents.
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (saved_views, custom_field_values, custom_field_definitions,
-- relationships, taggables, tags).

CREATE TABLE IF NOT EXISTS tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  name VARCHAR(128) NOT NULL,
  color VARCHAR(32)
);
CREATE INDEX IF NOT EXISTS tags_workspace_idx ON tags (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS tags_workspace_name_uidx
  ON tags (workspace_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS taggables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  tag_id UUID NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  object_type VARCHAR(64) NOT NULL,
  record_id UUID NOT NULL
);
CREATE INDEX IF NOT EXISTS taggables_object_record_idx ON taggables (object_type, record_id);
CREATE INDEX IF NOT EXISTS taggables_tag_idx ON taggables (tag_id);
CREATE UNIQUE INDEX IF NOT EXISTS taggables_tag_object_record_uidx
  ON taggables (tag_id, object_type, record_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  source_type VARCHAR(64) NOT NULL,
  source_id UUID NOT NULL,
  target_type VARCHAR(64) NOT NULL,
  target_id UUID NOT NULL,
  relationship_type VARCHAR(64) NOT NULL,
  label VARCHAR(255),
  metadata JSONB
);
CREATE INDEX IF NOT EXISTS relationships_source_idx ON relationships (source_type, source_id);
CREATE INDEX IF NOT EXISTS relationships_target_idx ON relationships (target_type, target_id);
CREATE INDEX IF NOT EXISTS relationships_type_idx ON relationships (relationship_type);
CREATE UNIQUE INDEX IF NOT EXISTS relationships_edge_uidx
  ON relationships (workspace_id, source_type, source_id, target_type, target_id, relationship_type)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  object_type VARCHAR(64) NOT NULL,
  key VARCHAR(128) NOT NULL,
  label VARCHAR(255) NOT NULL,
  field_type VARCHAR(32) NOT NULL,
  options JSONB,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  display_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS custom_field_definitions_object_idx
  ON custom_field_definitions (workspace_id, object_type);
CREATE UNIQUE INDEX IF NOT EXISTS custom_field_definitions_workspace_object_key_uidx
  ON custom_field_definitions (workspace_id, object_type, key) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS custom_field_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  definition_id UUID NOT NULL REFERENCES custom_field_definitions (id) ON DELETE CASCADE,
  record_id UUID NOT NULL,
  value JSONB
);
CREATE INDEX IF NOT EXISTS custom_field_values_record_idx ON custom_field_values (record_id);
CREATE INDEX IF NOT EXISTS custom_field_values_definition_idx ON custom_field_values (definition_id);
CREATE UNIQUE INDEX IF NOT EXISTS custom_field_values_definition_record_uidx
  ON custom_field_values (definition_id, record_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS saved_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  object_type VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  is_shared BOOLEAN NOT NULL DEFAULT FALSE,
  filter JSONB,
  columns JSONB,
  sort JSONB
);
CREATE INDEX IF NOT EXISTS saved_views_workspace_object_idx ON saved_views (workspace_id, object_type);
CREATE INDEX IF NOT EXISTS saved_views_owner_idx ON saved_views (owner_id);
