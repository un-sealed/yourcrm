-- 0150_calendar: Calendar module tables (spec 13-calendar, P0).
-- calendar_events + calendar_event_attendees, following 0010_people.sql
-- conventions (base columns, IF NOT EXISTS, indexes beside tables).
--
-- SCOPE: internal calendar events only. No external sync (Google Calendar,
-- Microsoft/Outlook, CalDAV), no OAuth, no booking pages, no recurrence —
-- those need an integrations framework and OAuth credential storage that do
-- not exist in this repo yet (see docs/yourcrm-agent-spec-pack/13-calendar.md,
-- P1/P2 scope).
--
-- start_at / end_at are TIMESTAMPTZ (UTC). Rendering in the workspace's
-- local timezone (workspaces.timezone) is a read-side concern handled by
-- packages/crm/src/calendar/timezone.ts and the web app — never stored
-- pre-converted.
--
-- owner_id, person_id, company_id, deal_id and
-- calendar_event_attendees.user_id are PLAIN uuid columns with an index and
-- NO foreign key: those tables are owned by other module agents (people,
-- companies, deals) or the foundation auth module (users), and this
-- migration must not create cross-package FKs (same rule as
-- people.company_id / tasks.person_id).
--
-- calendar_event_attendees.event_id IS a real FK to calendar_events: both
-- tables are defined in this same migration file and owned by this module.
--
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (calendar_event_attendees, calendar_events).

CREATE TABLE IF NOT EXISTS calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  location VARCHAR(500),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  all_day BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(32) NOT NULL DEFAULT 'confirmed',
  person_id UUID,
  company_id UUID,
  deal_id UUID,
  CONSTRAINT calendar_events_time_range_chk CHECK (end_at >= start_at)
);
CREATE INDEX IF NOT EXISTS calendar_events_workspace_idx ON calendar_events (workspace_id);
CREATE INDEX IF NOT EXISTS calendar_events_range_idx ON calendar_events (workspace_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS calendar_events_status_idx ON calendar_events (workspace_id, status);
CREATE INDEX IF NOT EXISTS calendar_events_person_idx ON calendar_events (person_id);
CREATE INDEX IF NOT EXISTS calendar_events_company_idx ON calendar_events (company_id);
CREATE INDEX IF NOT EXISTS calendar_events_deal_idx ON calendar_events (deal_id);

CREATE TABLE IF NOT EXISTS calendar_event_attendees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  event_id UUID NOT NULL REFERENCES calendar_events (id) ON DELETE CASCADE,
  user_id UUID,
  email VARCHAR(320),
  name VARCHAR(255),
  response_status VARCHAR(32) NOT NULL DEFAULT 'needs_action',
  is_organizer BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT calendar_event_attendees_target_chk CHECK (
    (user_id IS NOT NULL AND email IS NULL) OR (user_id IS NULL AND email IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS calendar_event_attendees_event_idx ON calendar_event_attendees (event_id);
CREATE INDEX IF NOT EXISTS calendar_event_attendees_workspace_idx ON calendar_event_attendees (workspace_id);
CREATE INDEX IF NOT EXISTS calendar_event_attendees_user_idx ON calendar_event_attendees (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_event_attendees_user_uidx
  ON calendar_event_attendees (event_id, user_id) WHERE deleted_at IS NULL AND user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS calendar_event_attendees_email_uidx
  ON calendar_event_attendees (event_id, lower(email)) WHERE deleted_at IS NULL AND email IS NOT NULL;
