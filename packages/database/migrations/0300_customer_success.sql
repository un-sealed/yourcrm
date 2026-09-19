-- 0300_customer_success: Customer Success & Retention tables
-- (spec 46-customer-success, P0).
-- cs_accounts, cs_health_scores, cs_renewals, cs_playbook_tasks, following
-- 0001_foundation.sql conventions (base columns, IF NOT EXISTS, indexes
-- beside tables).
--
-- cs_accounts.company_id and .owner_id are PLAIN uuid columns with an index
-- and NO foreign key: companies is owned by another module agent (same rule
-- as people.company_id in 0010_people.sql), and owner_id columns are
-- unconstrained repo-wide (see 0240_unified_inbox.sql). cs_playbook_tasks.
-- task_id is likewise a plain uuid pointing at tasks.id (owned by the tasks
-- module) — the row it references is created through that module's own
-- service, never written to directly here.
--
-- cs_health_scores / cs_renewals / cs_playbook_tasks -> cs_accounts use real
-- foreign keys with ON DELETE CASCADE: that reference stays inside this one
-- migration file, so it does not create the cross-module ordering problem
-- the "no FK" rule exists to avoid.
--
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (cs_playbook_tasks, cs_renewals, cs_health_scores, cs_accounts).

CREATE TABLE IF NOT EXISTS cs_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  company_id UUID NOT NULL,
  lifecycle_stage VARCHAR(32) NOT NULL DEFAULT 'onboarding',
  arr NUMERIC(14, 2),
  renewal_date DATE,
  notes TEXT,
  CONSTRAINT cs_accounts_lifecycle_chk CHECK (
    lifecycle_stage IN ('onboarding', 'adopting', 'healthy', 'at_risk', 'churned')
  )
);
CREATE INDEX IF NOT EXISTS cs_accounts_workspace_idx ON cs_accounts (workspace_id);
CREATE INDEX IF NOT EXISTS cs_accounts_company_idx ON cs_accounts (company_id);
CREATE INDEX IF NOT EXISTS cs_accounts_owner_idx ON cs_accounts (workspace_id, owner_id);
CREATE INDEX IF NOT EXISTS cs_accounts_lifecycle_idx ON cs_accounts (workspace_id, lifecycle_stage);
CREATE INDEX IF NOT EXISTS cs_accounts_renewal_date_idx ON cs_accounts (workspace_id, renewal_date);
CREATE UNIQUE INDEX IF NOT EXISTS cs_accounts_workspace_company_uidx
  ON cs_accounts (workspace_id, company_id);

CREATE TABLE IF NOT EXISTS cs_health_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES cs_accounts (id) ON DELETE CASCADE,
  score NUMERIC(5, 2) NOT NULL,
  -- [{ key, label, rawValue, normalizedScore, weight, contribution }] —
  -- computed server-side from the allowlisted factor registry in
  -- repositories/customer-success-repository.ts. Never user-supplied.
  factors JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  computed_by UUID,
  CONSTRAINT cs_health_scores_score_chk CHECK (score >= 0 AND score <= 100)
);
CREATE INDEX IF NOT EXISTS cs_health_scores_workspace_idx ON cs_health_scores (workspace_id);
CREATE INDEX IF NOT EXISTS cs_health_scores_account_computed_idx
  ON cs_health_scores (account_id, computed_at);

CREATE TABLE IF NOT EXISTS cs_renewals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES cs_accounts (id) ON DELETE CASCADE,
  renewal_date DATE NOT NULL,
  arr NUMERIC(14, 2),
  owner_id UUID,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  risk_flag BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  CONSTRAINT cs_renewals_status_chk CHECK (status IN ('open', 'won', 'lost'))
);
CREATE INDEX IF NOT EXISTS cs_renewals_workspace_idx ON cs_renewals (workspace_id);
CREATE INDEX IF NOT EXISTS cs_renewals_account_idx ON cs_renewals (account_id);
CREATE INDEX IF NOT EXISTS cs_renewals_renewal_date_idx ON cs_renewals (workspace_id, renewal_date);
CREATE INDEX IF NOT EXISTS cs_renewals_owner_idx ON cs_renewals (workspace_id, owner_id);
CREATE INDEX IF NOT EXISTS cs_renewals_risk_idx ON cs_renewals (workspace_id, risk_flag);

CREATE TABLE IF NOT EXISTS cs_playbook_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES cs_accounts (id) ON DELETE CASCADE,
  playbook_key VARCHAR(64) NOT NULL,
  task_id UUID NOT NULL,
  applied_by UUID,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cs_playbook_tasks_workspace_idx ON cs_playbook_tasks (workspace_id);
CREATE INDEX IF NOT EXISTS cs_playbook_tasks_account_idx ON cs_playbook_tasks (account_id);
CREATE INDEX IF NOT EXISTS cs_playbook_tasks_playbook_idx
  ON cs_playbook_tasks (workspace_id, playbook_key);
CREATE UNIQUE INDEX IF NOT EXISTS cs_playbook_tasks_task_uidx
  ON cs_playbook_tasks (workspace_id, task_id);
