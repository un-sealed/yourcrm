-- 0002_auth: email+password credentials + server-side sessions (spec 04-authentication).
-- Scope: Wave-1 auth only. No OAuth/OIDC/SAML/magic-link tables here.
-- Down migration: DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS credentials;
-- (then DELETE FROM schema_migrations WHERE filename = '0002_auth.sql').

-- One argon2id password hash per user. Separate table so the foundation
-- `users` definition is untouched; seed/demo passwords are upserted by
-- `packages/database/src/seed.ts` (migration order: migrate -> seed).
CREATE TABLE IF NOT EXISTS credentials (
  user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Server-side sessions. Only a SHA-256 hash of the token is stored here;
-- the raw token lives in the client's httpOnly cookie and is never logged.
-- Expiry and revocation are enforced server-side, never by the cookie.
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent TEXT,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_workspace_idx ON sessions (workspace_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);
