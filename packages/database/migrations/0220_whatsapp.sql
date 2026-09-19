-- 0220_whatsapp: WhatsApp module tables (spec 16-whatsapp, P0).
-- whatsapp_conversations + whatsapp_templates + whatsapp_messages, following
-- 0010_people.sql / 0180_integrations.sql conventions (base columns, IF NOT
-- EXISTS, indexes beside tables).
--
-- connection_id (on conversations and templates) is a PLAIN uuid column with
-- an index and NO foreign key: integration_connections belongs to the
-- integrations module, not this one (same rule as people.company_id,
-- 0010_people.sql). person_id / company_id on whatsapp_conversations are
-- likewise plain uuid columns with no FK.
--
-- conversation_id and template_id on whatsapp_messages ARE real FKs:
-- whatsapp_conversations and whatsapp_templates are defined in this same
-- migration and owned by this module.
--
-- SESSION WINDOW: the 24-hour WhatsApp Business rule (free-form text only
-- within 24h of the contact's last inbound message, an approved template
-- otherwise) is enforced in packages/crm/src/whatsapp/session-window.ts
-- against last_inbound_at. There is no DB constraint for it.
--
-- STATUS IDEMPOTENCY: whatsapp_messages_provider_message_uidx is the
-- idempotency key both for deduplicating inbound webhook deliveries and for
-- looking up a message to apply an out-of-order-safe status transition (see
-- applyMessageStatus in whatsapp-repository.ts). Deliberately scoped to
-- deleted_at IS NULL like every other soft-delete-aware unique index in this
-- codebase (contrast with integration_webhook_events_idempotency_uidx, which
-- is a different idempotency concern: a provider event id, not a message).
--
-- MEDIA: bytes live in @yourcrm/storage (S3/MinIO); only the storage key and
-- content metadata are stored here (spec 01-architecture "files").
--
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (whatsapp_messages, whatsapp_templates, whatsapp_conversations).

CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  contact_phone VARCHAR(32) NOT NULL,
  person_id UUID,
  company_id UUID,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  last_inbound_at TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  last_message_preview VARCHAR(255),
  unread_count INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT whatsapp_conversations_status_chk CHECK (status IN ('open', 'archived'))
);
CREATE INDEX IF NOT EXISTS whatsapp_conversations_workspace_idx
  ON whatsapp_conversations (workspace_id);
CREATE INDEX IF NOT EXISTS whatsapp_conversations_person_idx
  ON whatsapp_conversations (person_id);
CREATE INDEX IF NOT EXISTS whatsapp_conversations_company_idx
  ON whatsapp_conversations (company_id);
CREATE INDEX IF NOT EXISTS whatsapp_conversations_last_message_idx
  ON whatsapp_conversations (workspace_id, last_message_at);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_conversations_connection_phone_uidx
  ON whatsapp_conversations (workspace_id, connection_id, contact_phone)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  name VARCHAR(128) NOT NULL,
  language VARCHAR(16) NOT NULL DEFAULT 'en_US',
  category VARCHAR(32),
  status VARCHAR(16) NOT NULL DEFAULT 'approved',
  body_text TEXT NOT NULL,
  variable_count INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT whatsapp_templates_status_chk CHECK (status IN ('pending', 'approved', 'rejected'))
);
CREATE INDEX IF NOT EXISTS whatsapp_templates_workspace_idx
  ON whatsapp_templates (workspace_id);
CREATE INDEX IF NOT EXISTS whatsapp_templates_connection_idx
  ON whatsapp_templates (workspace_id, connection_id);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_templates_name_uidx
  ON whatsapp_templates (workspace_id, connection_id, name, language)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  conversation_id UUID NOT NULL REFERENCES whatsapp_conversations (id) ON DELETE CASCADE,
  direction VARCHAR(16) NOT NULL,
  kind VARCHAR(16) NOT NULL DEFAULT 'text',
  body TEXT,
  template_id UUID REFERENCES whatsapp_templates (id) ON DELETE SET NULL,
  template_variables JSONB,
  media_storage_key VARCHAR(512),
  media_content_type VARCHAR(128),
  media_file_name VARCHAR(255),
  media_size_bytes INTEGER,
  provider_message_id VARCHAR(255),
  status VARCHAR(16) NOT NULL DEFAULT 'queued',
  status_updated_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  error TEXT,
  CONSTRAINT whatsapp_messages_direction_chk CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT whatsapp_messages_kind_chk
    CHECK (kind IN ('text', 'template', 'image', 'document', 'audio', 'video', 'interactive', 'unknown')),
  CONSTRAINT whatsapp_messages_status_chk
    CHECK (status IN ('queued', 'sent', 'failed', 'delivered', 'read'))
);
CREATE INDEX IF NOT EXISTS whatsapp_messages_workspace_idx
  ON whatsapp_messages (workspace_id);
CREATE INDEX IF NOT EXISTS whatsapp_messages_conversation_idx
  ON whatsapp_messages (conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_provider_message_uidx
  ON whatsapp_messages (workspace_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL AND deleted_at IS NULL;
