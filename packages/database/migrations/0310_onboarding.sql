-- 0310_onboarding: Onboarding checklist state (spec 42-onboarding, P0).
-- One row per workspace. Step "done" state is NEVER stored as a trusted
-- boolean here — it is always recomputed by the domain service from real
-- data in people/deals/pipelines/memberships/workspaces. `step_completed_at`
-- is a write-through cache of "when the server first observed this step
-- done", populated only after the server itself derives `done = true`; it
-- is read-only history, never a source of truth for the `done` boolean.
-- `sample_data` records ids the service created via other modules' own
-- services (person/deal/pipeline) when seeding demo data, so they can be
-- identified and removed later — no table owned by onboarding is used to
-- store other modules' rows.
-- Down migration: DROP TABLE onboarding_progress.

CREATE TABLE IF NOT EXISTS onboarding_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  dismissed_at TIMESTAMPTZ,
  dismissed_by UUID,
  step_completed_at JSONB NOT NULL DEFAULT '{}'::jsonb,
  sample_data JSONB NOT NULL DEFAULT '[]'::jsonb,
  sample_data_seeded_at TIMESTAMPTZ,
  sample_data_seeded_by UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_progress_workspace_uidx
  ON onboarding_progress (workspace_id);
