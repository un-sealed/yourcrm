-- 0240_unified_inbox: Unified Inbox (spec 15-unified-inbox, P0).
--
-- ONE table. The inbox stream itself is NOT stored: it is a query-time union
-- over email_threads (0210), whatsapp_conversations (0220) and calls (0230),
-- assembled in packages/database/src/repositories/unified-inbox-repository.ts.
-- See packages/database/src/schema/unified-inbox.ts for the full argument
-- against a denormalised inbox_items projection (drift with no owner, and no
-- read win, since all three sources already index (workspace_id, timestamp)).
--
-- inbox_item_states is the OVERLAY: the inbox-owned facts (assignee, read
-- watermark, archived) that cannot live anywhere else, because this module may
-- not add columns to the three source tables it aggregates. It is sparse —
-- one row per conversation somebody has actually acted on.
--
-- channel + source_id form a POLYMORPHIC pointer: source_id is a plain UUID
-- with an index and NO foreign key, because the row it names lives in whichever
-- table `channel` selects and all three belong to other modules (same rule as
-- search_index.record_id, 0110_search.sql, and people.company_id,
-- 0010_people.sql). assigned_to / assigned_by point at users and are plain
-- UUIDs for the same reason every owner_id in this schema is.
--
-- read_at is a WATERMARK, not a boolean: an item is unread when
--   read_at IS NULL OR read_at < <last activity on the source row>.
-- That is what lets "mark read" survive the next inbound message without the
-- inbox ever writing to a source table.
--
-- inbox_item_states_item_uidx is FULL, not partial: re-acting on a
-- soft-deleted overlay row must revive it, never duplicate it.
--
-- Down migration: DROP TABLE inbox_item_states.

CREATE TABLE IF NOT EXISTS inbox_item_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  channel VARCHAR(16) NOT NULL,
  -- Polymorphic pointer: plain column, NO foreign key (see header).
  source_id UUID NOT NULL,
  -- users.id: plain column, NO foreign key (see header).
  assigned_to UUID,
  assigned_at TIMESTAMPTZ,
  assigned_by UUID,
  read_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  CONSTRAINT inbox_item_states_channel_chk
    CHECK (channel IN ('email', 'whatsapp', 'call'))
);

CREATE INDEX IF NOT EXISTS inbox_item_states_workspace_idx
  ON inbox_item_states (workspace_id);
CREATE INDEX IF NOT EXISTS inbox_item_states_assignee_idx
  ON inbox_item_states (workspace_id, assigned_to);
CREATE INDEX IF NOT EXISTS inbox_item_states_archived_idx
  ON inbox_item_states (workspace_id, archived_at);
CREATE INDEX IF NOT EXISTS inbox_item_states_source_idx
  ON inbox_item_states (source_id);

-- Join target for the stream and upsert target for every state write.
CREATE UNIQUE INDEX IF NOT EXISTS inbox_item_states_item_uidx
  ON inbox_item_states (workspace_id, channel, source_id);

COMMENT ON TABLE inbox_item_states IS
  'Unified inbox overlay (spec 15). Assignment/read/archive state for a conversation owned by email_threads, whatsapp_conversations or calls. The stream itself is a query-time union, not a projection.';
COMMENT ON COLUMN inbox_item_states.source_id IS
  'email_threads.id | whatsapp_conversations.id | calls.id, selected by channel. Plain uuid, no FK: those tables belong to other modules.';
COMMENT ON COLUMN inbox_item_states.read_at IS
  'Read watermark. Unread when read_at IS NULL OR read_at < last activity on the source row.';
COMMENT ON COLUMN inbox_item_states.assigned_to IS
  'users.id. Plain uuid, no FK: the auth foundation owns that table.';
