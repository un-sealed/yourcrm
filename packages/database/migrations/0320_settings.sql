-- 0320_settings: Settings, security & compliance (specs 40 + 41, P0).
--
-- WHAT THIS MIGRATION OWNS
-- ------------------------
--   teams              — grouping for ownership/visibility inside a workspace
--   team_members       — membership <-> team edge (memberships.role stays the
--                        authoritative access role; a team grants no rank)
--   workspace_invites  — invitation TOKENS (hash only, expiring)
--   data_requests      — GDPR/DPDP export + deletion requests
--
-- plus four columns on `workspaces` (the workspace profile already lives on
-- that row: name/timezone/currency). Date format and branding are more of the
-- same row, so they are columns here rather than a parallel settings table —
-- a second table would mean two sources of truth for one workspace profile.
--
-- WHAT IT DELIBERATELY DOES NOT CREATE
-- ------------------------------------
-- No roles/permissions tables. The role model is `memberships.role` plus the
-- role-rank policy in `@yourcrm/permissions`; this module configures it, it
-- does not replace it. No SSO/SCIM/MFA/IP-allowlist tables (out of P0 scope —
-- see the extension points in packages/crm/src/settings/service.ts).
--
-- FOREIGN KEYS
-- ------------
-- Only to tables this module owns (teams) plus the two foundation tables
-- every module may reference: workspaces and users. `membership_id` and
-- `subject_id` point at memberships and people, which belong to other
-- modules, so they are plain indexed UUIDs (same rule as people.company_id in
-- 0010_people.sql and inbox_item_states.source_id in 0240_unified_inbox.sql).
--
-- INVITE TOKENS
-- -------------
-- `token_hash` is the SHA-256 hex of a 32-byte CSPRNG token
-- (`@yourcrm/auth` tokens.ts — the same primitive sessions use). The raw
-- token is returned to the inviter exactly once, at creation, and is never
-- stored, logged or recoverable. An invite is therefore a bearer credential
-- with an expiry, not a password: revoking or resending replaces the hash.
--
-- AUDIT APPEND-ONLY
-- -----------------
-- `audit_events` (0001_foundation.sql) is the evidence trail this module puts
-- on screen, so its append-only property is enforced HERE at the storage
-- layer, not only by convention: a trigger rejects every UPDATE, DELETE and
-- TRUNCATE. `writeAudit()` only ever inserts, so nothing in the codebase is
-- affected; a future "fix up an audit row" patch fails loudly instead.
--
-- Down migration:
--   DROP TRIGGER audit_events_no_truncate ON audit_events;
--   DROP TRIGGER audit_events_no_mutate ON audit_events;
--   DROP FUNCTION audit_events_reject_mutation();
--   DROP TABLE data_requests, team_members, teams, workspace_invites;
--   ALTER TABLE workspaces DROP COLUMN date_format, DROP COLUMN logo_url,
--     DROP COLUMN brand_color, DROP COLUMN support_email;

-- ---------------------------------------------------------------------------
-- Workspace profile: extend the existing row (never a parallel table).
-- ---------------------------------------------------------------------------
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS date_format VARCHAR(32) NOT NULL DEFAULT 'YYYY-MM-DD';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS brand_color VARCHAR(16);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS support_email VARCHAR(320);

COMMENT ON COLUMN workspaces.date_format IS
  'Display date format for the workspace (token form, e.g. YYYY-MM-DD).';
COMMENT ON COLUMN workspaces.brand_color IS 'Branding accent colour, #rrggbb.';

-- ---------------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  description TEXT
);

CREATE INDEX IF NOT EXISTS teams_workspace_idx ON teams (workspace_id);
-- Partial: a soft-deleted team releases its slug so the name can be reused.
CREATE UNIQUE INDEX IF NOT EXISTS teams_workspace_slug_uidx
  ON teams (workspace_id, slug)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE teams IS
  'Workspace team (spec 41). A grouping for ownership/visibility only — access rank stays on memberships.role.';

CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  -- memberships.id: plain column, NO foreign key (foundation table, see header).
  membership_id UUID NOT NULL,
  team_role VARCHAR(16) NOT NULL DEFAULT 'member',
  CONSTRAINT team_members_team_role_chk CHECK (team_role IN ('member', 'lead'))
);

CREATE INDEX IF NOT EXISTS team_members_workspace_idx ON team_members (workspace_id);
CREATE INDEX IF NOT EXISTS team_members_membership_idx ON team_members (membership_id);
CREATE UNIQUE INDEX IF NOT EXISTS team_members_team_membership_uidx
  ON team_members (team_id, membership_id)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN team_members.membership_id IS
  'memberships.id. Plain uuid, no FK: the auth foundation owns that table.';
COMMENT ON COLUMN team_members.team_role IS
  'Position inside the team (member | lead). Carries NO permission rank.';

-- ---------------------------------------------------------------------------
-- Invitations — a token, never a password.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email VARCHAR(320) NOT NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'member',
  -- SHA-256 hex of the raw token. The raw token is NEVER stored.
  token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by UUID REFERENCES users (id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES users (id) ON DELETE SET NULL,
  invited_by UUID REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT workspace_invites_role_chk
    CHECK (role IN ('owner', 'admin', 'member', 'viewer'))
);

CREATE INDEX IF NOT EXISTS workspace_invites_workspace_idx ON workspace_invites (workspace_id);
-- Lookup key on acceptance: the raw token is hashed and matched here.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_invites_token_uidx
  ON workspace_invites (token_hash);
-- At most one live invite per address per workspace (resend rotates the hash).
CREATE UNIQUE INDEX IF NOT EXISTS workspace_invites_pending_email_uidx
  ON workspace_invites (workspace_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL AND deleted_at IS NULL;

COMMENT ON TABLE workspace_invites IS
  'Workspace invitation tokens (spec 41). Hash + expiry only: the raw token is shown once at creation and never persisted.';
COMMENT ON COLUMN workspace_invites.token_hash IS
  'SHA-256 hex of a 32-byte CSPRNG token (@yourcrm/auth tokens.ts). Never the raw token.';

-- ---------------------------------------------------------------------------
-- GDPR / DPDP data requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  kind VARCHAR(16) NOT NULL,
  subject_type VARCHAR(32) NOT NULL,
  -- people.id: plain column, NO foreign key (the people module owns it).
  subject_id UUID NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  reason TEXT,
  requested_by UUID REFERENCES users (id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT data_requests_kind_chk CHECK (kind IN ('export', 'deletion')),
  CONSTRAINT data_requests_subject_type_chk CHECK (subject_type IN ('person')),
  CONSTRAINT data_requests_status_chk
    CHECK (status IN ('pending', 'fulfilled', 'soft_deleted', 'rejected'))
);

CREATE INDEX IF NOT EXISTS data_requests_workspace_idx ON data_requests (workspace_id);
CREATE INDEX IF NOT EXISTS data_requests_subject_idx
  ON data_requests (workspace_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS data_requests_status_idx ON data_requests (workspace_id, status);

COMMENT ON TABLE data_requests IS
  'GDPR/DPDP export + deletion requests (spec 40). Deletion soft-deletes the subject and records the request; the purge itself is a later retention policy. Holds NO subject data: an export is assembled live from the owning module at download time, so no PII is duplicated at rest.';

-- ---------------------------------------------------------------------------
-- audit_events is append-only — enforced, not merely documented.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_no_mutate ON audit_events;
CREATE TRIGGER audit_events_no_mutate
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_mutation();

DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_mutation();

COMMENT ON FUNCTION audit_events_reject_mutation() IS
  'Append-only guard for audit_events (spec 40). writeAudit only inserts; any UPDATE/DELETE/TRUNCATE is a bug and fails here.';
