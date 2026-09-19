-- 0001_foundation: tenancy root + identity + audit + notifications.
-- Domain tables (people, companies, leads, deals, ...) are added by later
-- module agents following this same pattern. Down migration: DROP TABLE IN
-- REVERSE ORDER (audit_events, notifications, memberships, users, workspaces).

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  currency VARCHAR(8) NOT NULL DEFAULT 'USD'
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  email VARCHAR(320) NOT NULL UNIQUE,
  name VARCHAR(255),
  avatar_url TEXT,
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL DEFAULT 'member',
  UNIQUE (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_workspace_idx ON memberships (workspace_id);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  actor_id UUID,
  action VARCHAR(64) NOT NULL,
  object VARCHAR(64) NOT NULL,
  record_id UUID,
  before JSONB,
  after JSONB,
  correlation_id VARCHAR(64),
  source VARCHAR(32) NOT NULL DEFAULT 'user'
);
CREATE INDEX IF NOT EXISTS audit_events_workspace_idx ON audit_events (workspace_id);
CREATE INDEX IF NOT EXISTS audit_events_object_record_idx ON audit_events (object, record_id);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events (created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  type VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT,
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id);
