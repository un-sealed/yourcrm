-- 0270_sales_engagement: Sales Engagement & Sequences (spec 47, P0).
--
-- An ENGINE, not a CRUD module: a sequence is an ordered list of steps that
-- executes over time against an enrolled person, one queued job per step.
-- The decisions live in packages/crm/src/sequences; the transport lives in
-- apps/worker/src/jobs/sequences.ts. Four tables, all owned by this file.
--
--   sequences            the definition (draft / active / paused / archived)
--   sequence_steps       the ordered steps: email, task, wait
--   sequence_enrollments one person's progress through one sequence
--   sequence_step_runs   one row per (enrollment, step index) attempt
--
-- THE TWO UNIQUE INDEXES ARE LOAD-BEARING, NOT HYGIENE
-- ----------------------------------------------------
--  * sequence_step_runs_step_uidx (enrollment_id, step_index) is the
--    IDEMPOTENCY key. The runner inserts ON CONFLICT DO NOTHING and only
--    sends when the insert won the race ("claim before send"), so a retried
--    or duplicated job can never put a second copy of the same email on the
--    wire. Exactly the mechanism workflow_run_steps uses (0190_automation).
--  * sequence_enrollments_person_uidx (sequence_id, person_id) makes
--    enrolment itself idempotent: enrolling the same person twice returns
--    the existing enrollment instead of starting a parallel drip. It is
--    FULL, not partial, so re-enrolling a soft-deleted row revives it
--    rather than duplicating it (same rule as inbox_item_states, 0240).
--
-- EXIT CONDITIONS ARE THE POINT OF THE MODULE
-- -------------------------------------------
-- status + exit_reason on sequence_enrollments are the stop switch. The
-- runner refuses to execute any step of an enrollment whose status is not
-- 'active', so a job already sitting on the queue when the person replies
-- becomes a no-op — no cancellation race, no second email. thread_id is
-- what links an inbound reply back to the enrollment: it is written when
-- the first email step sends, and email.received / email.bounced carry the
-- same thread id in their envelope.
--
-- Unsubscribes and hard bounces are workspace-wide, not per-sequence: they
-- are derived from the enrollment rows themselves (any enrollment for this
-- person with exit_reason 'unsubscribed' or 'bounced' suppresses further
-- enrolment anywhere in the workspace), which is why no consent table
-- appears here.
--
-- FK POLICY: foreign keys only inside this migration. person_id, deal_id
-- and thread_id name rows owned by other modules (people 0010, deals 0040,
-- email 0210) and are therefore plain uuid columns with an index and no FK,
-- exactly as search_index.record_id (0110) and people.company_id (0010) are.
-- owner_id / enrolled_by / actor_id point at users and are plain uuid for
-- the same reason every owner_id in this schema is.
--
-- Down migration:
--   DROP TABLE sequence_step_runs, sequence_enrollments, sequence_steps, sequences;

CREATE TABLE IF NOT EXISTS sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  -- The actor every step of this sequence executes AS. Permission
  -- inheritance: the runner re-reads THIS user's live workspace role and
  -- checks it before each step, so the sequence is never more privileged
  -- than its owner is right now.
  owner_id UUID,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  -- Stop conditions. Reply and bounce are configurable per sequence;
  -- unsubscribe and manual removal are unconditional and therefore not
  -- columns.
  exit_on_reply BOOLEAN NOT NULL DEFAULT TRUE,
  exit_on_bounce BOOLEAN NOT NULL DEFAULT TRUE,
  last_enrolled_at TIMESTAMPTZ,
  CONSTRAINT sequences_status_chk
    CHECK (status IN ('draft', 'active', 'paused', 'archived'))
);

CREATE INDEX IF NOT EXISTS sequences_workspace_idx ON sequences (workspace_id);
CREATE INDEX IF NOT EXISTS sequences_status_idx ON sequences (workspace_id, status);
CREATE INDEX IF NOT EXISTS sequences_owner_idx ON sequences (owner_id);

COMMENT ON TABLE sequences IS
  'Sales sequence definition (spec 47). Ordered outreach steps executed over time as the owner.';
COMMENT ON COLUMN sequences.owner_id IS
  'users.id. Plain uuid, no FK. Steps execute as this actor; their LIVE role is re-read per step.';

CREATE TABLE IF NOT EXISTS sequence_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  sequence_id UUID NOT NULL REFERENCES sequences (id) ON DELETE CASCADE,
  -- Position in the sequence, 0-based. Also the idempotency coordinate on
  -- sequence_step_runs.
  step_index INTEGER NOT NULL,
  step_type VARCHAR(16) NOT NULL,
  name VARCHAR(255),
  -- Delay applied BEFORE this step runs. A 'wait' step is a step that does
  -- nothing except wait, so it must carry a non-zero delay.
  wait_days INTEGER NOT NULL DEFAULT 0,
  wait_hours INTEGER NOT NULL DEFAULT 0,
  -- Step payload, validated by the zod variant for step_type before it is
  -- stored (email: subject/body; task: title/priority/due; wait: {}).
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT sequence_steps_type_chk
    CHECK (step_type IN ('email', 'task', 'wait')),
  CONSTRAINT sequence_steps_wait_days_chk CHECK (wait_days BETWEEN 0 AND 365),
  CONSTRAINT sequence_steps_wait_hours_chk CHECK (wait_hours BETWEEN 0 AND 23),
  CONSTRAINT sequence_steps_wait_nonzero_chk
    CHECK (step_type <> 'wait' OR wait_days > 0 OR wait_hours > 0)
);

CREATE INDEX IF NOT EXISTS sequence_steps_workspace_idx ON sequence_steps (workspace_id);
-- Ordered lookup for "the steps of this sequence", and the guarantee that
-- two steps can never claim the same position.
CREATE UNIQUE INDEX IF NOT EXISTS sequence_steps_position_uidx
  ON sequence_steps (sequence_id, step_index);

COMMENT ON TABLE sequence_steps IS
  'Ordered steps of a sales sequence (spec 47, P0): email, task or wait. No SMS/WhatsApp/call in P0.';

CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  sequence_id UUID NOT NULL REFERENCES sequences (id) ON DELETE CASCADE,
  -- people.id / deals.id: plain columns, NO foreign key (see header).
  person_id UUID NOT NULL,
  deal_id UUID,
  -- Resolved once at enrolment so a later contact edit cannot silently
  -- redirect an in-flight sequence to a different mailbox.
  email_address VARCHAR(320) NOT NULL,
  -- email_threads.id, written by the first email step. The join key that
  -- turns an inbound reply into an exit.
  thread_id UUID,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  -- Why the enrollment stopped. NULL while it is still running.
  exit_reason VARCHAR(32),
  current_step_index INTEGER NOT NULL DEFAULT 0,
  next_run_at TIMESTAMPTZ,
  sent_count INTEGER NOT NULL DEFAULT 0,
  enrolled_by UUID,
  actor_role VARCHAR(32),
  started_at TIMESTAMPTZ,
  last_step_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  error TEXT,
  CONSTRAINT sequence_enrollments_status_chk
    CHECK (status IN ('active', 'paused', 'completed', 'stopped', 'failed')),
  CONSTRAINT sequence_enrollments_exit_reason_chk
    CHECK (
      exit_reason IS NULL
      OR exit_reason IN (
        'replied', 'bounced', 'unsubscribed', 'removed',
        'sequence_archived', 'completed', 'failed'
      )
    ),
  CONSTRAINT sequence_enrollments_step_index_chk CHECK (current_step_index >= 0)
);

CREATE INDEX IF NOT EXISTS sequence_enrollments_workspace_idx
  ON sequence_enrollments (workspace_id);
CREATE INDEX IF NOT EXISTS sequence_enrollments_sequence_idx
  ON sequence_enrollments (sequence_id, created_at);
-- Exit lookups: "every live enrollment for this person / this thread".
CREATE INDEX IF NOT EXISTS sequence_enrollments_person_idx
  ON sequence_enrollments (workspace_id, person_id);
CREATE INDEX IF NOT EXISTS sequence_enrollments_thread_idx
  ON sequence_enrollments (workspace_id, thread_id);
CREATE INDEX IF NOT EXISTS sequence_enrollments_email_idx
  ON sequence_enrollments (workspace_id, email_address);
-- Due-step scan for the scheduler.
CREATE INDEX IF NOT EXISTS sequence_enrollments_due_idx
  ON sequence_enrollments (workspace_id, status, next_run_at);
-- One enrollment per (sequence, person), forever. Full (not partial) so a
-- re-enrolment revives the row instead of duplicating it.
CREATE UNIQUE INDEX IF NOT EXISTS sequence_enrollments_person_uidx
  ON sequence_enrollments (sequence_id, person_id);

COMMENT ON TABLE sequence_enrollments IS
  'One person''s progress through one sales sequence (spec 47). status <> ''active'' stops every queued step.';
COMMENT ON COLUMN sequence_enrollments.person_id IS
  'people.id. Plain uuid, no FK: the people module owns that table.';
COMMENT ON COLUMN sequence_enrollments.thread_id IS
  'email_threads.id. Plain uuid, no FK. Links an inbound reply back to this enrollment so it can exit.';
COMMENT ON COLUMN sequence_enrollments.exit_reason IS
  'Why the sequence stopped: replied, bounced, unsubscribed, removed, sequence_archived, completed, failed.';

CREATE TABLE IF NOT EXISTS sequence_step_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  enrollment_id UUID NOT NULL REFERENCES sequence_enrollments (id) ON DELETE CASCADE,
  -- Same migration, so a real FK. SET NULL because a step may be deleted
  -- from the definition after it has already run for somebody.
  step_id UUID REFERENCES sequence_steps (id) ON DELETE SET NULL,
  step_index INTEGER NOT NULL,
  step_type VARCHAR(16) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  -- What the step did, e.g. { messageId, threadId } or { taskId }. Never
  -- message bodies, never secrets.
  result JSONB,
  error TEXT,
  -- The sequence owner the step executed as, and the role it was granted.
  actor_id UUID,
  actor_role VARCHAR(32),
  finished_at TIMESTAMPTZ,
  CONSTRAINT sequence_step_runs_status_chk
    CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  CONSTRAINT sequence_step_runs_type_chk
    CHECK (step_type IN ('email', 'task', 'wait'))
);

CREATE INDEX IF NOT EXISTS sequence_step_runs_workspace_idx
  ON sequence_step_runs (workspace_id);
CREATE INDEX IF NOT EXISTS sequence_step_runs_step_idx ON sequence_step_runs (step_id);
-- THE IDEMPOTENCY KEY. A retried job re-claims this slot, loses the insert
-- and skips the send. Doubles as the ordered lookup for one enrollment.
CREATE UNIQUE INDEX IF NOT EXISTS sequence_step_runs_step_uidx
  ON sequence_step_runs (enrollment_id, step_index);

COMMENT ON TABLE sequence_step_runs IS
  'One attempt at one step of one enrollment (spec 47). UNIQUE (enrollment_id, step_index) is the send-once guarantee.';
COMMENT ON COLUMN sequence_step_runs.actor_role IS
  'Workspace role the sequence owner held when this step ran, re-read live rather than snapshotted at authoring time.';
