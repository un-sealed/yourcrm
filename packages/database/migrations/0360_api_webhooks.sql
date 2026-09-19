-- 0360_api_webhooks: outbound webhook subscriptions, delivery log and public
-- API keys (spec 32-api-webhooks, P0). Follows 0010_people.sql conventions
-- (base columns, IF NOT EXISTS, indexes beside their table) and mirrors
-- 0180_integrations.sql for secret storage — this module is the OUTBOUND
-- direction of the same idea, so it reuses that encryption approach rather
-- than inventing a second one.
--
-- SECRETS: webhook_subscriptions has NO plaintext secret column. The signing
-- secret is sealed with AES-256-GCM (ENCRYPTION_KEY, @yourcrm/config) by
-- repositories/api-webhooks-repository.ts, reusing `createIntegrationCipher`
-- from repositories/integrations-repository.ts; ciphertext, a per-write
-- random IV and the GCM auth tag are stored separately, so a tampered row
-- fails authentication instead of decrypting to garbage. `secret_hint` is
-- the masked display value and is the only secret-derived value any API
-- response may contain.
--
-- api_keys stores a SHA-256 hash of the raw key and nothing else. There is
-- no column a raw key could live in, so "show it once at creation" is
-- enforced by the schema, not by discipline. Hashing (not encryption) is
-- correct here: the server only ever needs to RECOGNISE a presented key,
-- never to reproduce one. A plain SHA-256 is sufficient because the key is
-- 32 CSPRNG bytes — the same reasoning as `auth_sessions.token_hash`
-- (0002_auth.sql) — so there is no low-entropy secret to brute-force.
--
-- SSRF: target_url is attacker-controlled and the server fetches it. The
-- CHECK below is the last line of defence only (scheme). The real guard is
-- packages/crm/src/api-webhooks/url-guard.ts, which runs at save time AND
-- again immediately before every delivery attempt, because DNS can change
-- between the two.
--
-- IDEMPOTENCY: webhook_deliveries_idempotency_uidx on
-- (subscription_id, event_id) IS the no-double-delivery guarantee. A
-- retried job, a redelivered bus event and a racing enqueue all collide on
-- it. It is deliberately NOT filtered on deleted_at: idempotency must hold
-- for the lifetime of the subscription, including for soft-deleted rows.
--
-- workspace_id, created_by and updated_by are PLAIN uuid columns with NO
-- foreign key (same rule as people.company_id, 0010_people.sql).
-- subscription_id IS a real FK: webhook_deliveries is defined in this same
-- migration and owned by this module.
--
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (api_keys, webhook_deliveries, webhook_subscriptions).

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  target_url TEXT NOT NULL,
  -- Subscribed event names, validated against the exported @yourcrm/events
  -- constants before they ever reach SQL. Empty means "delivers nothing",
  -- which is always a mistake, so the CHECK rejects it.
  event_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  secret_algorithm VARCHAR(32) NOT NULL DEFAULT 'aes-256-gcm',
  secret_key_version VARCHAR(16) NOT NULL DEFAULT 'v1',
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_auth_tag TEXT NOT NULL,
  -- Masked display value, e.g. 'whsec_…4f2a'. Never the secret itself.
  secret_hint VARCHAR(64),
  secret_rotated_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_delivery_at TIMESTAMPTZ,
  last_delivery_status VARCHAR(32),
  disabled_at TIMESTAMPTZ,
  disabled_reason TEXT,
  CONSTRAINT webhook_subscriptions_https_chk
    CHECK (target_url LIKE 'https://%'),
  CONSTRAINT webhook_subscriptions_events_chk
    CHECK (jsonb_typeof(event_names) = 'array' AND jsonb_array_length(event_names) > 0)
);
CREATE INDEX IF NOT EXISTS webhook_subscriptions_workspace_idx
  ON webhook_subscriptions (workspace_id);
CREATE INDEX IF NOT EXISTS webhook_subscriptions_active_idx
  ON webhook_subscriptions (workspace_id, active);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_subscriptions_name_uidx
  ON webhook_subscriptions (workspace_id, name)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  subscription_id UUID NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE CASCADE,
  -- Envelope id of the triggering domain event (or a derived replay id).
  event_id VARCHAR(128) NOT NULL,
  event_name VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  -- Exact bytes that were (or will be) signed and POSTed. Stored so a
  -- replay re-sends what the subscriber originally missed.
  body TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 6,
  next_attempt_at TIMESTAMPTZ,
  -- One JSON object per attempt: { attempt, at, outcome, statusCode,
  -- durationMs, responseSnippet, error }. Bounded by max_attempts, so this
  -- stays small and needs no fourth table.
  attempts JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_status_code INTEGER,
  last_response_snippet TEXT,
  last_duration_ms INTEGER,
  last_error TEXT,
  succeeded_at TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  dead_letter_reason TEXT,
  replay_of_id UUID REFERENCES webhook_deliveries (id) ON DELETE SET NULL,
  CONSTRAINT webhook_deliveries_status_chk
    CHECK (status IN ('pending', 'delivering', 'succeeded', 'failed', 'dead_lettered'))
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_workspace_idx
  ON webhook_deliveries (workspace_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_subscription_idx
  ON webhook_deliveries (subscription_id, created_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_status_idx
  ON webhook_deliveries (workspace_id, status);
-- THE idempotency guarantee — see the header.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_idempotency_uidx
  ON webhook_deliveries (subscription_id, event_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  -- SHA-256 hex of the raw key. There is no column for the key itself.
  key_hash VARCHAR(64) NOT NULL,
  -- Non-secret display parts: 'ycrm_sk' and the last four characters.
  key_prefix VARCHAR(32) NOT NULL,
  last_four VARCHAR(8) NOT NULL,
  -- Workspace role this key acts as. Clamped at creation so a key can never
  -- exceed its creator's own role (spec 32 §8).
  role VARCHAR(32) NOT NULL DEFAULT 'viewer',
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID,
  CONSTRAINT api_keys_role_chk
    CHECK (role IN ('owner', 'admin', 'member', 'viewer'))
);
CREATE INDEX IF NOT EXISTS api_keys_workspace_idx
  ON api_keys (workspace_id);
-- Authentication looks a presented key up by hash, globally: the hash must
-- be unique across workspaces, and the lookup must not need a workspace
-- hint the caller has not proven yet.
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uidx
  ON api_keys (key_hash);
