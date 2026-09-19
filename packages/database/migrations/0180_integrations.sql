-- 0180_integrations: Integrations framework tables (spec 31-integrations, P0).
-- integration_connections + integration_credentials +
-- integration_webhook_events, following 0010_people.sql conventions (base
-- columns, IF NOT EXISTS, indexes beside tables).
--
-- SCOPE: API-key connections only. No OAuth redirect handling, no token
-- refresh, no PKCE — those need callback routing and a public URL this
-- deployment does not have. The storage is already shaped for them
-- (credentials.kind = 'oauth_tokens', scopes, expires_at, key_version), so
-- adding OAuth later needs no migration. See the extension-point note in
-- packages/integrations/src/provider.ts.
--
-- SECRETS: integration_credentials has NO plaintext column, on purpose.
-- Secrets are sealed with AES-256-GCM (ENCRYPTION_KEY, @yourcrm/config) in
-- repositories/integrations-repository.ts before they reach SQL: ciphertext,
-- a per-write random iv and the GCM auth_tag are stored separately, so a
-- tampered row fails authentication instead of decrypting to garbage. `hint`
-- is the masked display value (e.g. 'sk-…4f2a') and is the only
-- credential-derived value any API response may contain.
--
-- workspace_id, created_by and updated_by are PLAIN uuid columns with NO
-- foreign key (same rule as people.company_id, 0010_people.sql).
-- connection_id IS a real FK: integration_credentials and
-- integration_webhook_events are defined in this same migration and owned by
-- this module.
--
-- integration_webhook_events_idempotency_uidx is deliberately NOT filtered on
-- deleted_at: idempotency on a provider event id must hold for the lifetime
-- of the connection, including for soft-deleted rows.
--
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (integration_webhook_events, integration_credentials,
-- integration_connections).

CREATE TABLE IF NOT EXISTS integration_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  provider_id VARCHAR(64) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'disconnected',
  auth_kind VARCHAR(32) NOT NULL DEFAULT 'api_key',
  external_account_id VARCHAR(255),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  connected_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  last_health_check_at TIMESTAMPTZ,
  last_health_status VARCHAR(32),
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  CONSTRAINT integration_connections_status_chk
    CHECK (status IN ('connected', 'disconnected', 'error'))
);
CREATE INDEX IF NOT EXISTS integration_connections_workspace_idx
  ON integration_connections (workspace_id);
CREATE INDEX IF NOT EXISTS integration_connections_provider_idx
  ON integration_connections (workspace_id, provider_id);
CREATE INDEX IF NOT EXISTS integration_connections_status_idx
  ON integration_connections (workspace_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_account_uidx
  ON integration_connections (workspace_id, provider_id, external_account_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS integration_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  connection_id UUID NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  kind VARCHAR(32) NOT NULL,
  algorithm VARCHAR(32) NOT NULL DEFAULT 'aes-256-gcm',
  key_version VARCHAR(16) NOT NULL DEFAULT 'v1',
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  hint VARCHAR(64),
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  CONSTRAINT integration_credentials_kind_chk
    CHECK (kind IN ('api_key', 'webhook_secret', 'oauth_tokens'))
);
CREATE INDEX IF NOT EXISTS integration_credentials_workspace_idx
  ON integration_credentials (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS integration_credentials_slot_uidx
  ON integration_credentials (connection_id, kind)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS integration_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  connection_id UUID NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  provider_id VARCHAR(64) NOT NULL,
  provider_event_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(128),
  status VARCHAR(32) NOT NULL DEFAULT 'received',
  payload JSONB,
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT integration_webhook_events_status_chk
    CHECK (status IN ('received', 'processed', 'ignored', 'failed'))
);
CREATE INDEX IF NOT EXISTS integration_webhook_events_workspace_idx
  ON integration_webhook_events (workspace_id);
CREATE INDEX IF NOT EXISTS integration_webhook_events_connection_idx
  ON integration_webhook_events (connection_id, received_at);
CREATE INDEX IF NOT EXISTS integration_webhook_events_status_idx
  ON integration_webhook_events (workspace_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS integration_webhook_events_idempotency_uidx
  ON integration_webhook_events (connection_id, provider_event_id);
