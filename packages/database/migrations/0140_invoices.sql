-- 0140_invoices: Invoices & Payments module tables
-- (spec 20-invoices-payments, P0), following 0001_foundation.sql conventions
-- (base columns, IF NOT EXISTS, indexes beside tables).
-- invoice_line_items.invoice_id and payments.invoice_id are same-module FKs
-- (safe: all three tables are created in this file).
-- company_id / person_id / quote_id are PLAIN uuid columns with indexes and
-- NO foreign keys — companies/people are owned by other modules and quotes
-- (slot 0150) does not exist yet (same rule as people.company_id).
-- Money is stored as integer minor units (*_cents) so totals stay exact.
-- balance_due is DERIVED (line-item total minus recorded payments) and is
-- never stored; overdue is derived from due_date the same way.
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (payments, invoice_line_items, invoices).

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  number VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  currency VARCHAR(8) NOT NULL DEFAULT 'USD',
  issue_date DATE,
  due_date DATE,
  -- Cross-module references (plain uuid, no FK — see header).
  company_id UUID,
  person_id UUID,
  quote_id UUID,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS invoices_workspace_idx ON invoices (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_workspace_number_uidx
  ON invoices (workspace_id, number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices (workspace_id, status);
CREATE INDEX IF NOT EXISTS invoices_company_idx ON invoices (company_id);
CREATE INDEX IF NOT EXISTS invoices_person_idx ON invoices (person_id);
CREATE INDEX IF NOT EXISTS invoices_quote_idx ON invoices (quote_id);
CREATE INDEX IF NOT EXISTS invoices_due_date_idx ON invoices (workspace_id, due_date);

CREATE TABLE IF NOT EXISTS invoice_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  invoice_id UUID NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_amount_cents INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS invoice_line_items_invoice_idx ON invoice_line_items (invoice_id);
CREATE INDEX IF NOT EXISTS invoice_line_items_workspace_idx ON invoice_line_items (workspace_id);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  invoice_id UUID NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'USD',
  method VARCHAR(32) NOT NULL DEFAULT 'other',
  paid_at DATE,
  reference VARCHAR(255),
  notes TEXT
);
CREATE INDEX IF NOT EXISTS payments_invoice_idx ON payments (invoice_id);
CREATE INDEX IF NOT EXISTS payments_workspace_idx ON payments (workspace_id);
