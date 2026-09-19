-- 0370_notifications: Notifications module (spec 43-notifications, P0).
--
-- The `notifications` table itself already exists (0001_foundation.sql) and
-- is left untouched here except for one additive index. This migration adds
-- `notification_preferences` — the missing piece: per-user category +
-- channel toggles and quiet hours, enforced server-side at send time by
-- `packages/crm/src/notifications`.
--
-- workspace_id / user_id are PLAIN uuid columns with NO foreign key, same
-- convention as `notifications.user_id` and every other module table
-- (people.company_id, calls.owner_id, ...): workspace/user existence is
-- guaranteed by the session/permission layer, not a DB constraint.
--
-- Down migration: DROP INDEX notifications_workspace_user_unread_idx;
-- DROP TABLE notification_preferences.

-- Every list query is scoped to (workspace_id, user_id) — a user only ever
-- reads their own notifications — and orders unread-first, so this
-- composite index covers both the ownership filter and the sort.
CREATE INDEX IF NOT EXISTS notifications_workspace_user_unread_idx
  ON notifications (workspace_id, user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  categories JSONB NOT NULL DEFAULT '{}'::jsonb,
  quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  quiet_hours_start VARCHAR(5),
  quiet_hours_end VARCHAR(5),
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC'
);
CREATE INDEX IF NOT EXISTS notification_preferences_workspace_idx
  ON notification_preferences (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS notification_preferences_user_uidx
  ON notification_preferences (workspace_id, user_id) WHERE deleted_at IS NULL;

COMMENT ON TABLE notification_preferences IS
  'Per-user notification preferences (spec 43, P0): which categories/channels are enabled, plus quiet hours. Enforced server-side at send time in packages/crm/src/notifications — a suppressed notification is never inserted into `notifications`.';
COMMENT ON COLUMN notification_preferences.categories IS
  'JSONB map: category name -> {in_app, email, push, sms} booleans. A category absent from the map uses the default (in_app: true, others false) — see resolveChannels() in packages/crm/src/notifications/preferences.ts.';
COMMENT ON COLUMN notification_preferences.quiet_hours_start IS
  '"HH:MM" wall-clock in `timezone`. NULL/quiet_hours_enabled=false means quiet hours are off.';
COMMENT ON COLUMN notification_preferences.timezone IS
  'IANA timezone name for quiet-hours evaluation. Defaults to UTC (per-user, distinct from workspaces.timezone).';
