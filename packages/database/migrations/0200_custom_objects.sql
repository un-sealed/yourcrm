-- 0200_custom_objects: Custom Objects & Fields (spec 33-custom-objects-fields, P0).
--
-- NO RUNTIME DDL. This is the ONLY schema change the module ever makes.
-- User-defined object types are ROWS in custom_object_definitions and their
-- records are ROWS in custom_object_records with a single jsonb payload.
-- The application never issues CREATE TABLE / ALTER TABLE in response to
-- user input: runtime DDL is an injection surface, it cannot be reviewed,
-- versioned or rolled back like a migration, and it explodes the catalog
-- per tenant. Validation happens in application code against the field
-- definitions instead (buildCustomObjectRecordSchema in @yourcrm/crm).
--
-- FIELDS: extends 0003_shared_tables, does not replace it. Fields of a
-- custom object are ordinary custom_field_definitions rows whose
-- object_type holds the object's slug (built-in objects keep using
-- 'person', 'deal', ...). The existing
-- custom_field_definitions_workspace_object_key_uidx therefore already
-- enforces per-object field-key uniqueness, and custom_field_values keeps
-- working untouched for built-in records. The only change to the existing
-- tables is one additive, nullable column: default_value.
--
-- FOREIGN KEYS: custom_object_records.object_id references
-- custom_object_definitions, which is created in this same file. No
-- foreign key is added to or from tables owned by other module agents —
-- in particular custom_field_definitions.object_type stays a plain
-- varchar join key, exactly as the shared-tables migration defined it.
--
-- Down migration:
--   DROP TABLE IF EXISTS custom_object_records;
--   DROP TABLE IF EXISTS custom_object_definitions;
--   ALTER TABLE custom_field_definitions DROP COLUMN IF EXISTS default_value;

-- ---------------------------------------------------------------------------
-- Additive extension of the existing field catalog.
-- ---------------------------------------------------------------------------
ALTER TABLE custom_field_definitions
  ADD COLUMN IF NOT EXISTS default_value JSONB;

-- ---------------------------------------------------------------------------
-- Object definitions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_object_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  -- Immutable programmatic name. Appears in API paths and joins to
  -- custom_field_definitions.object_type, so the service validates it
  -- against a strict allowlist pattern and a reserved-word list before
  -- it ever reaches SQL. CHECK is the last line of defence.
  slug VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  plural_name VARCHAR(128) NOT NULL,
  icon VARCHAR(64),
  description TEXT,
  CONSTRAINT custom_object_definitions_slug_format
    CHECK (slug ~ '^[a-z][a-z0-9]*([-_][a-z0-9]+)*$' AND length(slug) BETWEEN 2 AND 64)
);
CREATE INDEX IF NOT EXISTS custom_object_definitions_workspace_idx
  ON custom_object_definitions (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS custom_object_definitions_workspace_slug_uidx
  ON custom_object_definitions (workspace_id, slug) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Records of a custom object.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_object_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  object_id UUID NOT NULL REFERENCES custom_object_definitions (id) ON DELETE CASCADE,
  -- Denormalized from the object's first text field so lists, headers and
  -- ordering never have to crack the jsonb.
  display_name VARCHAR(255) NOT NULL DEFAULT 'Untitled',
  -- Deliberately NOT named "values": VALUES is a reserved word in Postgres.
  -- Keys are custom_field_definitions.key values (immutable snake_case);
  -- the object form guards against __proto__/constructor style keys.
  field_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT custom_object_records_field_values_object
    CHECK (jsonb_typeof(field_values) = 'object')
);
CREATE INDEX IF NOT EXISTS custom_object_records_object_idx
  ON custom_object_records (workspace_id, object_id);
CREATE INDEX IF NOT EXISTS custom_object_records_owner_idx ON custom_object_records (owner_id);
CREATE INDEX IF NOT EXISTS custom_object_records_display_name_idx
  ON custom_object_records (workspace_id, display_name);
CREATE INDEX IF NOT EXISTS custom_object_records_field_values_idx
  ON custom_object_records USING GIN (field_values);
