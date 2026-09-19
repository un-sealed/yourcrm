-- 0230_calling: Calling module tables (spec 17-calling, P0).
-- calls + call_recordings, following 0010_people.sql conventions (base
-- columns, IF NOT EXISTS, indexes beside tables).
--
-- SCOPE: call logging (manual + click-to-call), status tracking with
-- out-of-order/idempotent webhook handling (see
-- packages/crm/src/calling/status.ts), and recording METADATA only.
--
-- workspace_id, owner_id, person_id, company_id, deal_id and connection_id
-- are PLAIN uuid columns with NO foreign key: people/companies/deals belong
-- to other modules and integration_connections belongs to the integrations
-- module (same rule as people.company_id, 0010_people.sql). call_id on
-- call_recordings IS a real FK — both tables are defined in this migration.
--
-- RECORDINGS: call_recordings stores url/duration_bytes/size only. Bytes
-- live in S3/MinIO via @yourcrm/storage; this table has no bytea/blob
-- column, on purpose, so nothing here can grow unbounded or leak audio into
-- a database backup. `calls.recording_consent` defaults to false and must
-- be set explicitly — consent policy varies by jurisdiction and must never
-- be assumed.
--
-- STATUS: calls_provider_call_uidx is a partial unique index (provider_call_id
-- IS NOT NULL) so a provider's status webhook can look up the call it
-- belongs to via (workspace_id, provider_id, provider_call_id); manual logs
-- never populate provider_call_id and are excluded from the index.
--
-- Down migration: DROP TABLE IN REVERSE ORDER (call_recordings, calls).

CREATE TABLE IF NOT EXISTS calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  direction VARCHAR(16) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  source VARCHAR(16) NOT NULL DEFAULT 'manual',
  from_number VARCHAR(32) NOT NULL,
  to_number VARCHAR(32) NOT NULL,
  person_id UUID,
  company_id UUID,
  deal_id UUID,
  connection_id UUID,
  provider_id VARCHAR(64),
  provider_call_id VARCHAR(255),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  disposition VARCHAR(64),
  notes TEXT,
  recording_consent BOOLEAN NOT NULL DEFAULT FALSE,
  error_message TEXT,
  CONSTRAINT calls_direction_chk CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT calls_status_chk
    CHECK (status IN ('queued', 'ringing', 'in_progress', 'completed', 'failed', 'no_answer', 'busy')),
  CONSTRAINT calls_source_chk CHECK (source IN ('manual', 'provider'))
);
CREATE INDEX IF NOT EXISTS calls_workspace_idx ON calls (workspace_id);
CREATE INDEX IF NOT EXISTS calls_status_idx ON calls (workspace_id, status);
CREATE INDEX IF NOT EXISTS calls_direction_idx ON calls (workspace_id, direction);
CREATE INDEX IF NOT EXISTS calls_owner_idx ON calls (workspace_id, owner_id);
CREATE INDEX IF NOT EXISTS calls_person_idx ON calls (workspace_id, person_id);
CREATE INDEX IF NOT EXISTS calls_company_idx ON calls (workspace_id, company_id);
CREATE INDEX IF NOT EXISTS calls_deal_idx ON calls (workspace_id, deal_id);
CREATE INDEX IF NOT EXISTS calls_connection_idx ON calls (workspace_id, connection_id);
CREATE INDEX IF NOT EXISTS calls_created_idx ON calls (workspace_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS calls_provider_call_uidx
  ON calls (workspace_id, provider_id, provider_call_id)
  WHERE deleted_at IS NULL AND provider_call_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS call_recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  call_id UUID NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  duration_seconds INTEGER,
  size_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS call_recordings_workspace_idx ON call_recordings (workspace_id);
CREATE INDEX IF NOT EXISTS call_recordings_call_idx ON call_recordings (call_id);
