-- 0250_support: Support / Ticketing module tables (spec 21-support, P0),
-- following 0001_foundation.sql conventions (base columns, IF NOT EXISTS,
-- indexes beside tables).
--
-- ticket_comments.ticket_id is a same-module FK (safe: both tables are
-- created in this file, cascade delete).
--
-- requester_id / assignee_id / author_id are PLAIN uuid columns with
-- indexes and NO foreign keys: people (requester) and users (assignee,
-- comment author) are owned by other modules/the auth foundation, same
-- rule as people.company_id and quotes.person_id. This module does not
-- own people or users, so it never constrains against them.
--
-- STATUS LIFECYCLE (new -> open -> pending -> resolved -> closed, with
-- reopen edges) is enforced in the domain service's transition table
-- (packages/crm/src/support/service.ts), never by a generic PATCH. The
-- CHECK constraints below are a second line of defense against bad rows
-- from any path that is not the service (backfills, manual fixes).
--
-- SLA FIELDS: first_response_due_at / resolution_due_at are computed by the
-- domain service from the ticket's priority at creation time (and recomputed
-- when priority changes before that milestone is reached) and stored here as
-- plain mutable columns — never derived at read time, so they survive a
-- priority policy change without rewriting history. first_response_at /
-- resolved_at are the actual timestamps, set by the service when the first
-- public comment lands / the ticket transitions to resolved.
--
-- NO BACKGROUND SLA BREACH JOB IN P0 (see AGENTS.md scope). The two partial
-- indexes below (`tickets_first_response_due_idx`, `tickets_resolution_due_idx`)
-- are the extension point: a future worker job scans
-- `WHERE first_response_due_at < now() AND first_response_at IS NULL` (and the
-- resolution equivalent) to raise breach notifications/events without a table
-- scan. Wiring that job, plus the `ticket.*` event group it would emit on
-- breach, is out of scope for this migration (see service.ts header for the
-- event-group blocker).
--
-- Down migration: DROP TABLE IN REVERSE ORDER (ticket_comments, tickets).

CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  subject VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'new',
  priority VARCHAR(16) NOT NULL DEFAULT 'normal',
  -- Cross-module reference (plain uuid, no FK — see header). people.id.
  requester_id UUID NOT NULL,
  -- Cross-module reference (plain uuid, no FK — see header). users.id.
  assignee_id UUID,
  channel VARCHAR(16) NOT NULL DEFAULT 'manual',
  first_response_due_at TIMESTAMPTZ,
  first_response_at TIMESTAMPTZ,
  resolution_due_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  CONSTRAINT tickets_status_chk
    CHECK (status IN ('new', 'open', 'pending', 'resolved', 'closed')),
  CONSTRAINT tickets_priority_chk
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT tickets_channel_chk
    CHECK (channel IN ('email', 'chat', 'whatsapp', 'phone', 'web', 'api', 'manual'))
);
CREATE INDEX IF NOT EXISTS tickets_workspace_idx ON tickets (workspace_id);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (workspace_id, status);
CREATE INDEX IF NOT EXISTS tickets_priority_idx ON tickets (workspace_id, priority);
CREATE INDEX IF NOT EXISTS tickets_requester_idx ON tickets (requester_id);
CREATE INDEX IF NOT EXISTS tickets_assignee_idx ON tickets (workspace_id, assignee_id);
-- Breach-scan extension point (see header): only rows still awaiting a first
-- response / resolution are relevant, so both indexes are partial.
CREATE INDEX IF NOT EXISTS tickets_first_response_due_idx
  ON tickets (workspace_id, first_response_due_at) WHERE first_response_at IS NULL;
CREATE INDEX IF NOT EXISTS tickets_resolution_due_idx
  ON tickets (workspace_id, resolution_due_at) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS ticket_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  ticket_id UUID NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  -- Cross-module reference (plain uuid, no FK — see header). users.id.
  author_id UUID NOT NULL,
  body TEXT NOT NULL,
  -- Internal notes are staff-only and must never be exposed on any
  -- requester-reachable endpoint — enforced in the domain service
  -- (see the `getForStaff` / `getForRequester` split in service.ts), not by
  -- this flag alone.
  is_internal BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS ticket_comments_ticket_idx ON ticket_comments (ticket_id);
CREATE INDEX IF NOT EXISTS ticket_comments_workspace_idx ON ticket_comments (workspace_id);
