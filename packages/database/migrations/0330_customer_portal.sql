-- 0330_customer_portal: Customer Portal (spec 45-customer-portal, P0).
--
-- THE POINT OF THIS MODULE: it exposes CRM rows to people who are NOT
-- workspace members. Every other module's permission model assumes the caller
-- is a member with a role; that assumption is false here, so this module does
-- not reuse it. Read packages/crm/src/portal/service.ts before changing
-- anything in this file.
--
-- THREE TABLES, ONE INVARIANT
-- ---------------------------
--   portal_identities    a person who has been granted portal access.
--                        NOT a user; NOT a membership. It maps to a
--                        people.id and nothing else.
--   portal_access_grants the *entire* set of records that identity may read,
--                        expressed as (scope_type, scope_id) pairs plus a
--                        per-resource flag. No grant row => no readable row,
--                        ever. There is no implicit access.
--   portal_sessions      both halves of magic-link auth: a short-lived
--                        single-use 'magic_link' row and the 'session' row it
--                        is exchanged for. Only SHA-256 hashes of the tokens
--                        are stored; the raw token exists in the email and in
--                        the customer's cookie, never in this database.
--
-- WHY MAGIC LINKS LIVE IN portal_sessions: a pending link IS a session that
-- has not started yet. Keeping both kinds in one table means one uniqueness
-- domain for token_hash, one expiry sweep, and one revocation path. `kind`
-- separates them and the CHECK below keeps consumed_at meaningful.
--
-- SINGLE USE IS ENFORCED BY THE DATABASE, not by the service:
--   UPDATE portal_sessions SET consumed_at = NOW()
--    WHERE token_hash = $1 AND kind = 'magic_link'
--      AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
--   RETURNING ...
-- Two concurrent exchanges of the same link: exactly one gets a row back.
--
-- NO FOREIGN KEYS TO TABLES THIS MODULE DOES NOT OWN. person_id / scope_id
-- point at people and companies, which other modules own (same rule as
-- people.company_id in 0010 and search_index.record_id in 0110). The FKs that
-- do exist (portal_access_grants.portal_identity_id, portal_sessions
-- .portal_identity_id) are same-file and ON DELETE CASCADE: deleting an
-- identity must take its grants and its live sessions with it, immediately.
--
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (portal_sessions, portal_access_grants, portal_identities).

CREATE TABLE IF NOT EXISTS portal_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- people.id. Plain uuid, NO foreign key (see header).
  person_id UUID NOT NULL,
  -- Stored already lowercased and trimmed by the repository.
  email VARCHAR(320) NOT NULL,
  display_name VARCHAR(255),
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  -- Access expiry (spec 45 §3). NULL means "until revoked".
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  CONSTRAINT portal_identities_status_chk CHECK (status IN ('active', 'revoked'))
);

CREATE INDEX IF NOT EXISTS portal_identities_workspace_idx
  ON portal_identities (workspace_id);
-- One portal identity per email per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS portal_identities_workspace_email_uidx
  ON portal_identities (workspace_id, email) WHERE deleted_at IS NULL;
-- Magic-link requests arrive with an email and NO workspace context (the
-- caller is not signed in and has no tenant yet), so the lookup is by email
-- across workspaces and this index is deliberately not workspace-first.
CREATE INDEX IF NOT EXISTS portal_identities_email_idx ON portal_identities (email);
CREATE INDEX IF NOT EXISTS portal_identities_person_idx ON portal_identities (person_id);

CREATE TABLE IF NOT EXISTS portal_access_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  portal_identity_id UUID NOT NULL REFERENCES portal_identities (id) ON DELETE CASCADE,
  -- 'person' => scope_id is a people.id; 'company' => a companies.id.
  -- Plain uuid, NO foreign key (see header).
  scope_type VARCHAR(16) NOT NULL,
  scope_id UUID NOT NULL,
  -- Per-resource entitlement. Default false: a grant grants nothing until
  -- somebody says which resource it covers.
  can_view_tickets BOOLEAN NOT NULL DEFAULT FALSE,
  can_view_invoices BOOLEAN NOT NULL DEFAULT FALSE,
  can_view_quotes BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT portal_access_grants_scope_type_chk CHECK (scope_type IN ('person', 'company'))
);

CREATE INDEX IF NOT EXISTS portal_access_grants_workspace_idx
  ON portal_access_grants (workspace_id);
-- The hot path: "which scopes may this identity read right now".
CREATE INDEX IF NOT EXISTS portal_access_grants_identity_idx
  ON portal_access_grants (workspace_id, portal_identity_id);
CREATE INDEX IF NOT EXISTS portal_access_grants_scope_idx
  ON portal_access_grants (workspace_id, scope_type, scope_id);
CREATE UNIQUE INDEX IF NOT EXISTS portal_access_grants_identity_scope_uidx
  ON portal_access_grants (workspace_id, portal_identity_id, scope_type, scope_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS portal_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  portal_identity_id UUID NOT NULL REFERENCES portal_identities (id) ON DELETE CASCADE,
  -- 'magic_link' = unexchanged, single-use challenge. 'session' = live cookie.
  kind VARCHAR(16) NOT NULL,
  -- SHA-256 hex of the raw token (@yourcrm/auth hashSessionToken). The raw
  -- token is NEVER stored and NEVER logged.
  token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  -- Set once, by the atomic single-use UPDATE in the header. Only meaningful
  -- for 'magic_link' rows.
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  user_agent VARCHAR(255),
  CONSTRAINT portal_sessions_kind_chk CHECK (kind IN ('magic_link', 'session')),
  CONSTRAINT portal_sessions_consumed_chk
    CHECK (consumed_at IS NULL OR kind = 'magic_link')
);

-- Global, not per-workspace: a token must resolve to exactly one row before
-- any tenant is known, and two identical hashes would make that ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS portal_sessions_token_hash_uidx
  ON portal_sessions (token_hash);
CREATE INDEX IF NOT EXISTS portal_sessions_identity_idx
  ON portal_sessions (workspace_id, portal_identity_id);
CREATE INDEX IF NOT EXISTS portal_sessions_expires_idx ON portal_sessions (expires_at);

COMMENT ON TABLE portal_identities IS
  'Customer portal identity (spec 45). A person granted external portal access. NOT a workspace user: it has no membership and no role, and it never satisfies requirePermission().';
COMMENT ON COLUMN portal_identities.person_id IS
  'people.id. Plain uuid, no FK: the people module owns that table.';
COMMENT ON TABLE portal_access_grants IS
  'The complete allow-list for one portal identity. Every portal query joins against these rows in SQL; no grant means no readable record.';
COMMENT ON TABLE portal_sessions IS
  'Portal magic-link challenges and portal sessions. Entirely separate from the member `sessions` table in 0002_auth.sql: different table, different cookie, different resolver.';
COMMENT ON COLUMN portal_sessions.token_hash IS
  'SHA-256 hex of the raw token. Raw tokens are never stored or logged.';
