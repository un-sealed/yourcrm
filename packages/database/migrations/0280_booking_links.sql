-- 0280_booking_links: Booking Links module tables (spec 48-booking-links, P0).
-- booking_links + booking_availability_rules + bookings, following
-- 0010_people.sql / 0150_calendar.sql conventions (base columns, IF NOT
-- EXISTS, indexes beside tables).
--
-- SCOPE (P0): a single owner per link, no payment collection, no
-- round-robin/team links, no Google/Microsoft calendar sync, no SMS
-- reminders — see docs/yourcrm-agent-spec-pack/48-booking-links.md.
--
-- owner_id is a PLAIN uuid column with an index and NO foreign key: users is
-- a foundation table owned by another module wave and this migration must
-- not assume ordering (same rule as people.company_id / calendar.owner_id).
-- bookings.calendar_event_id is likewise a PLAIN uuid column with NO foreign
-- key: calendar_events is owned by the calendar module, and cross-module FKs
-- are never allowed regardless of table existence.
--
-- booking_availability_rules.booking_link_id and bookings.booking_link_id ARE
-- real FKs to booking_links: all three tables are defined in this same
-- migration file and owned by this module.
--
-- starts_at / ends_at are TIMESTAMPTZ (UTC). Rendering / interpreting wall
-- clock times in the workspace's local timezone is a read-side concern
-- handled by packages/crm/src/calendar/timezone.ts (reused, not
-- reimplemented) — never stored pre-converted.
--
-- DOUBLE-BOOKING GUARD (the correctness property that matters): a confirmed
-- booking occupies its exact slot start exclusively. bookings_link_start_uidx
-- is a UNIQUE index on (booking_link_id, starts_at) filtered to
-- status = 'confirmed', so two invitees racing the same slot cannot both
-- insert a confirmed row — the second insert fails with a unique-violation
-- (23505) at the database level, not via a check-then-insert race in
-- application code. Cancelling a booking (status -> 'cancelled') frees the
-- slot for reuse automatically because the partial index only covers
-- confirmed rows.
--
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (bookings, booking_availability_rules, booking_links).

CREATE TABLE IF NOT EXISTS booking_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID NOT NULL,
  slug VARCHAR(160) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL,
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
  buffer_after_minutes INTEGER NOT NULL DEFAULT 0,
  min_notice_minutes INTEGER NOT NULL DEFAULT 60,
  max_days_ahead INTEGER NOT NULL DEFAULT 30,
  location VARCHAR(500),
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  CONSTRAINT booking_links_duration_chk CHECK (duration_minutes > 0 AND duration_minutes <= 1440),
  CONSTRAINT booking_links_buffer_chk CHECK (buffer_before_minutes >= 0 AND buffer_after_minutes >= 0),
  CONSTRAINT booking_links_notice_chk CHECK (min_notice_minutes >= 0),
  CONSTRAINT booking_links_horizon_chk CHECK (max_days_ahead > 0)
);
CREATE INDEX IF NOT EXISTS booking_links_workspace_idx ON booking_links (workspace_id);
CREATE INDEX IF NOT EXISTS booking_links_owner_idx ON booking_links (owner_id);
CREATE INDEX IF NOT EXISTS booking_links_status_idx ON booking_links (workspace_id, status);
-- Public lookup by slug (apps/book/[slug]) is workspace-agnostic, so the
-- share slug must be globally unique (same pattern as forms.public_id).
CREATE UNIQUE INDEX IF NOT EXISTS booking_links_slug_uidx ON booking_links (lower(slug));

CREATE TABLE IF NOT EXISTS booking_availability_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  booking_link_id UUID NOT NULL REFERENCES booking_links (id) ON DELETE CASCADE,
  -- 0 = Sunday .. 6 = Saturday (Intl/JS Date.getUTCDay() convention).
  day_of_week SMALLINT NOT NULL,
  -- Minutes since local midnight (workspace timezone), [0, 1440).
  start_minute SMALLINT NOT NULL,
  end_minute SMALLINT NOT NULL,
  CONSTRAINT booking_availability_rules_day_chk CHECK (day_of_week BETWEEN 0 AND 6),
  CONSTRAINT booking_availability_rules_minutes_chk CHECK (
    start_minute >= 0 AND end_minute > start_minute AND end_minute <= 1440
  )
);
CREATE INDEX IF NOT EXISTS booking_availability_rules_link_idx
  ON booking_availability_rules (booking_link_id);
CREATE INDEX IF NOT EXISTS booking_availability_rules_workspace_idx
  ON booking_availability_rules (workspace_id);

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  booking_link_id UUID NOT NULL REFERENCES booking_links (id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  invitee_name VARCHAR(255) NOT NULL,
  invitee_email VARCHAR(320) NOT NULL,
  invitee_timezone VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'confirmed',
  -- Cross-module reference to calendar_events (plain uuid, no FK — see header).
  calendar_event_id UUID,
  notes TEXT,
  cancellation_reason TEXT,
  CONSTRAINT bookings_time_range_chk CHECK (ends_at >= starts_at)
);
CREATE INDEX IF NOT EXISTS bookings_link_idx ON bookings (booking_link_id);
CREATE INDEX IF NOT EXISTS bookings_workspace_idx ON bookings (workspace_id);
CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings (workspace_id, status);
CREATE INDEX IF NOT EXISTS bookings_range_idx ON bookings (booking_link_id, starts_at, ends_at);
-- THE double-booking guard: see header comment.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_link_start_uidx
  ON bookings (booking_link_id, starts_at) WHERE status = 'confirmed';
