-- 0380_marketplace: Marketplace / Plugin SDK tables (spec 49-marketplace-sdk, P0).
-- marketplace_apps + app_installations + app_scope_grants, following
-- 0010_people.sql conventions (base columns, IF NOT EXISTS, indexes beside
-- tables).
--
-- SCOPE: manifest + scoped API access + webhooks declaration only. NO code
-- execution: there is no plugin runtime, sandbox, eval or dynamic import
-- anywhere in this module. `marketplace_apps.manifest` is an inert JSON
-- document, validated by zod in packages/crm/src/marketplace/schemas.ts
-- before it ever reaches this table.
--
-- marketplace_apps is deliberately NOT workspace-scoped: the catalogue is
-- shared across every workspace in this deployment, mirroring how
-- @yourcrm/integrations' provider registry is process-wide rather than
-- per-workspace. See the header comment in
-- packages/database/src/schema/marketplace.ts and MARKETPLACE.md for the
-- full rationale. workspace_id (on the other two tables), publisher_workspace_id
-- and installed_by are PLAIN uuid columns with NO foreign key, matching the
-- rest of this codebase's convention (same rule as people.company_id,
-- 0010_people.sql) even though workspaces/users are tables this migration is
-- allowed to reference.
--
-- SCOPE ENFORCEMENT: app_scope_grants is the enforcement surface. An
-- installed app may act only within the (object, action) pairs that have a
-- live (deleted_at IS NULL) row here. Grants are capped, at install time, by
-- BOTH the manifest's requested scopes AND the installing user's own
-- workspace-role permissions — whichever is narrower wins. See
-- packages/crm/src/marketplace/access.ts.
--
-- Uninstall soft-deletes every grant row for the installation (no orphaned
-- access) and soft-deletes + marks the installation 'uninstalled'.
--
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (app_scope_grants, app_installations, marketplace_apps).

CREATE TABLE IF NOT EXISTS marketplace_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  app_key VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  version VARCHAR(32) NOT NULL,
  publisher VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'published',
  manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  publisher_workspace_id UUID,
  CONSTRAINT marketplace_apps_status_chk
    CHECK (status IN ('draft', 'published', 'deprecated'))
);
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_apps_key_uidx
  ON marketplace_apps (app_key)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS marketplace_apps_status_idx
  ON marketplace_apps (status);

CREATE TABLE IF NOT EXISTS app_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  app_id UUID NOT NULL REFERENCES marketplace_apps (id) ON DELETE CASCADE,
  app_version VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  installed_by UUID,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uninstalled_at TIMESTAMPTZ,
  CONSTRAINT app_installations_status_chk
    CHECK (status IN ('active', 'uninstalled'))
);
CREATE INDEX IF NOT EXISTS app_installations_workspace_idx
  ON app_installations (workspace_id);
CREATE INDEX IF NOT EXISTS app_installations_app_idx
  ON app_installations (app_id);
CREATE UNIQUE INDEX IF NOT EXISTS app_installations_workspace_app_uidx
  ON app_installations (workspace_id, app_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS app_scope_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  installation_id UUID NOT NULL REFERENCES app_installations (id) ON DELETE CASCADE,
  object VARCHAR(64) NOT NULL,
  action VARCHAR(32) NOT NULL
);
CREATE INDEX IF NOT EXISTS app_scope_grants_workspace_idx
  ON app_scope_grants (workspace_id);
CREATE INDEX IF NOT EXISTS app_scope_grants_installation_idx
  ON app_scope_grants (installation_id);
CREATE UNIQUE INDEX IF NOT EXISTS app_scope_grants_unique_live_uidx
  ON app_scope_grants (installation_id, object, action)
  WHERE deleted_at IS NULL;
