-- 0290_marketing: Marketing / Campaigns module tables (spec 24-marketing, P0).
-- Follows 0001_foundation.sql conventions (base columns, IF NOT EXISTS,
-- indexes beside tables).
--
-- marketing_segments: a NAMED FILTER TREE over people (the same encoding as
--   reports.filter / @yourcrm/ui's FilterBuilder — there is exactly one
--   filter model in the product). Evaluated at send time, never
--   materialised as membership rows.
-- campaigns: name/subject/body + segment + lifecycle status + counters.
--   segment_id IS a real foreign key: marketing_segments is owned by THIS
--   migration.
-- campaign_recipients: one row per (campaign, person) the campaign is
--   allowed to email. INSERTED ONLY from the consent-filtered SQL in
--   repositories/marketing-repository.ts (`prepareRecipients`) — a person
--   who lacks consent or has unsubscribed never gets a row, so exclusion
--   happens in SQL, not by filtering a list afterwards. The unique index on
--   (campaign_id, person_id) plus claim-before-send (status
--   pending -> sending, `FOR UPDATE SKIP LOCKED`) makes a retried batch a
--   no-op instead of a second email.
-- marketing_consents: durable per-person marketing consent / unsubscribe
--   state, independent of any one campaign (an unsubscribe must exclude the
--   person from every FUTURE campaign, not just the one they clicked from).
--   Not one of the three P0 nouns named in the spec, but required
--   infrastructure for "consent and unsubscribe are not optional" — see the
--   module README / PR notes.
--
-- CROSS-MODULE LINKS: person_id (marketing_consents, campaign_recipients)
-- and owner_id (marketing_segments, campaigns) are PLAIN uuid columns with
-- an index and NO foreign key: people/users belong to other module agents
-- (same rule as people.company_id in 0010_people.sql). FKs in this file
-- only point at tables this migration creates.
--
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (campaign_recipients, campaigns, marketing_consents, marketing_segments).

CREATE TABLE IF NOT EXISTS marketing_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  -- Filter tree in the @yourcrm/ui FilterBuilder encoding:
  -- { type: 'group', id, combinator: 'and'|'or', children: [...] }.
  -- Same restated model as reports.filter (packages/database/src/schema/reports.ts).
  filter JSONB NOT NULL DEFAULT '{"type":"group","id":"root","combinator":"and","children":[]}',
  -- Cached from the last evaluation (preview / prepareRecipients). Informational
  -- only — send time always re-evaluates the filter in SQL.
  member_count INTEGER,
  last_evaluated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS marketing_segments_workspace_idx ON marketing_segments (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS marketing_segments_workspace_name_uidx
  ON marketing_segments (workspace_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS marketing_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  person_id UUID NOT NULL,
  -- Explicit opt-in required: a person with NO row, or consent = false, or
  -- unsubscribed_at set, is excluded. There is no implicit "consent by
  -- default" path (spec 17: respect retention/consent policies).
  marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
  unsubscribed_at TIMESTAMPTZ,
  -- Opaque bearer credential embedded in every send's unsubscribe link.
  -- Unsubscribing needs only the token (spec: "every send must carry an
  -- unsubscribe mechanism") — no session, no workspace role.
  unsubscribe_token UUID NOT NULL DEFAULT gen_random_uuid(),
  consent_source VARCHAR(32) NOT NULL DEFAULT 'manual',
  last_consent_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS marketing_consents_workspace_idx ON marketing_consents (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS marketing_consents_workspace_person_uidx
  ON marketing_consents (workspace_id, person_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS marketing_consents_token_uidx
  ON marketing_consents (unsubscribe_token);

CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  name VARCHAR(255) NOT NULL,
  subject VARCHAR(998) NOT NULL,
  body_html TEXT,
  body_text TEXT,
  segment_id UUID NOT NULL REFERENCES marketing_segments (id),
  -- draft -> scheduled -> sending -> sent, or -> cancelled from draft/scheduled.
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  -- Plain uuid: the email integration connection to send through
  -- (integration_connections belongs to the email/integrations module).
  connection_id UUID,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT campaigns_status_check
    CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS campaigns_workspace_idx ON campaigns (workspace_id);
CREATE INDEX IF NOT EXISTS campaigns_workspace_status_idx ON campaigns (workspace_id, status);
CREATE INDEX IF NOT EXISTS campaigns_segment_idx ON campaigns (segment_id);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  campaign_id UUID NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  person_id UUID NOT NULL,
  -- pending -> sending (claimed) -> sent | failed.
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  -- Plain uuid: the email_messages row the send produced (email module).
  email_message_id UUID,
  claimed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  failed_reason TEXT,
  CONSTRAINT campaign_recipients_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'failed'))
);
-- THE idempotency guarantee: a person can appear at most once per campaign,
-- so a retried/duplicated prepare (or a segment that matches the same
-- person twice) cannot create a second send.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_recipients_campaign_person_uidx
  ON campaign_recipients (campaign_id, person_id);
CREATE INDEX IF NOT EXISTS campaign_recipients_campaign_status_idx
  ON campaign_recipients (campaign_id, status);
CREATE INDEX IF NOT EXISTS campaign_recipients_workspace_idx ON campaign_recipients (workspace_id);
