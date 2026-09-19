-- 0210_email: Email module tables (spec 14-email, P0).
-- email_threads + email_messages + email_participants + email_attachments,
-- following 0010_people.sql conventions (base columns, IF NOT EXISTS,
-- indexes beside tables).
--
-- SCOPE: provider-delivered email only. No IMAP/POP polling, no OAuth, no
-- raw RFC822/MIME parsing. Outbound goes through an @yourcrm/integrations
-- provider adapter; inbound arrives on the framework's signed webhook as a
-- structured payload. Templates, open/click tracking, scheduled send and
-- sequences are P1 and have no columns here.
--
-- THREADING is what these columns exist for (algorithm:
-- packages/crm/src/email/threading.ts):
--   * email_messages.message_id     — RFC 5322 Message-ID, normalised
--                                     (angle brackets stripped, lower-cased)
--   * email_messages.in_reply_to    — normalised parent Message-ID
--   * email_messages.reference_ids  — normalised References chain, oldest
--                                     first. Named reference_ids, NOT
--                                     references: REFERENCES is a reserved
--                                     word and would need quoting everywhere.
--   * email_threads.normalized_subject + email_threads.participant_key —
--     the fallback when a message carries no usable reference chain.
--     participant_key is a sha256 hex digest of the thread's sorted,
--     de-duplicated address set, so matching is an index lookup rather than
--     a set comparison in SQL. Both are frozen from the thread's first
--     message so later replies adding recipients cannot re-key a thread.
--
-- email_messages_message_id_uidx is the webhook idempotency guard and is
-- deliberately NOT filtered on deleted_at: a provider retry must not be able
-- to resurrect a message a user deleted.
--
-- ATTACHMENTS are metadata only. Bytes live in S3/MinIO (@yourcrm/storage)
-- behind storage_key, exactly like the files table (0100_files.sql). There
-- is intentionally no bytea/base64 column.
--
-- SECRETS: nothing here stores a credential. The provider API key lives in
-- integration_credentials (0180_integrations.sql), sealed with AES-256-GCM.
-- last_error holds an already-redacted provider reason.
--
-- workspace_id, created_by, updated_by, owner_id, person_id, company_id,
-- deal_id and connection_id are PLAIN uuid columns with NO foreign key
-- (same rule as people.company_id, 0010_people.sql) — those tables belong
-- to other modules. thread_id and email_message_id ARE real foreign keys:
-- every table they point at is created in this same migration.
--
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (email_attachments, email_participants, email_messages, email_threads).

CREATE TABLE IF NOT EXISTS email_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  subject TEXT,
  normalized_subject TEXT NOT NULL DEFAULT '',
  participant_key VARCHAR(64) NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  person_id UUID,
  company_id UUID,
  deal_id UUID,
  CONSTRAINT email_threads_status_chk CHECK (status IN ('open', 'archived'))
);
CREATE INDEX IF NOT EXISTS email_threads_workspace_idx ON email_threads (workspace_id);
CREATE INDEX IF NOT EXISTS email_threads_recent_idx
  ON email_threads (workspace_id, last_message_at);
CREATE INDEX IF NOT EXISTS email_threads_status_idx ON email_threads (workspace_id, status);
CREATE INDEX IF NOT EXISTS email_threads_match_idx
  ON email_threads (workspace_id, normalized_subject, participant_key);
CREATE INDEX IF NOT EXISTS email_threads_person_idx ON email_threads (person_id);
CREATE INDEX IF NOT EXISTS email_threads_company_idx ON email_threads (company_id);
CREATE INDEX IF NOT EXISTS email_threads_deal_idx ON email_threads (deal_id);

CREATE TABLE IF NOT EXISTS email_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  thread_id UUID NOT NULL REFERENCES email_threads (id) ON DELETE CASCADE,
  direction VARCHAR(16) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'queued',
  message_id VARCHAR(998),
  in_reply_to VARCHAR(998),
  reference_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject TEXT,
  from_address VARCHAR(320),
  from_name VARCHAR(255),
  body_text TEXT,
  body_html TEXT,
  snippet VARCHAR(280),
  has_attachments BOOLEAN NOT NULL DEFAULT FALSE,
  connection_id UUID,
  provider_id VARCHAR(64),
  provider_message_id VARCHAR(255),
  sent_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  person_id UUID,
  company_id UUID,
  deal_id UUID,
  CONSTRAINT email_messages_direction_chk CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT email_messages_status_chk
    CHECK (status IN ('queued', 'sent', 'delivered', 'bounced', 'failed', 'received'))
);
CREATE INDEX IF NOT EXISTS email_messages_workspace_idx ON email_messages (workspace_id);
CREATE INDEX IF NOT EXISTS email_messages_thread_idx ON email_messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS email_messages_status_idx
  ON email_messages (workspace_id, direction, status);
CREATE INDEX IF NOT EXISTS email_messages_provider_idx
  ON email_messages (workspace_id, provider_message_id);
CREATE INDEX IF NOT EXISTS email_messages_person_idx ON email_messages (person_id);
CREATE INDEX IF NOT EXISTS email_messages_company_idx ON email_messages (company_id);
CREATE INDEX IF NOT EXISTS email_messages_deal_idx ON email_messages (deal_id);
CREATE INDEX IF NOT EXISTS email_messages_message_id_idx
  ON email_messages (workspace_id, message_id);
CREATE UNIQUE INDEX IF NOT EXISTS email_messages_message_id_uidx
  ON email_messages (workspace_id, message_id) WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  email_message_id UUID NOT NULL REFERENCES email_messages (id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES email_threads (id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL,
  address VARCHAR(320) NOT NULL,
  display_name VARCHAR(255),
  person_id UUID,
  CONSTRAINT email_participants_role_chk
    CHECK (role IN ('from', 'to', 'cc', 'bcc', 'reply_to'))
);
CREATE INDEX IF NOT EXISTS email_participants_message_idx
  ON email_participants (email_message_id);
CREATE INDEX IF NOT EXISTS email_participants_thread_idx ON email_participants (thread_id);
CREATE INDEX IF NOT EXISTS email_participants_address_idx
  ON email_participants (workspace_id, address);
CREATE INDEX IF NOT EXISTS email_participants_person_idx ON email_participants (person_id);
CREATE UNIQUE INDEX IF NOT EXISTS email_participants_unique_uidx
  ON email_participants (email_message_id, role, address) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS email_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  email_message_id UUID NOT NULL REFERENCES email_messages (id) ON DELETE CASCADE,
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(128),
  size_bytes INTEGER NOT NULL DEFAULT 0,
  storage_key TEXT,
  content_id VARCHAR(255),
  is_inline BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS email_attachments_message_idx
  ON email_attachments (email_message_id);
CREATE INDEX IF NOT EXISTS email_attachments_workspace_idx
  ON email_attachments (workspace_id);
