-- 0130_quotes: Quotes & Proposals module tables (spec 19-quotes, P0),
-- following 0001_foundation.sql conventions (base columns, IF NOT EXISTS,
-- indexes beside tables).
-- quote_line_items.quote_id is a same-module FK (safe: both tables are
-- created in this file).
-- company_id / person_id / deal_id / product_id are PLAIN uuid columns
-- with indexes and NO foreign keys — companies/people/deals/products are
-- owned by other module agents (same rule as people.company_id and
-- 0140_invoices.sql).
-- Money is stored as integer minor units (*_cents) so totals stay exact.
-- Discount/tax rates are stored as integer basis points (*_bps, 10000 =
-- 100%) for the same reason. subtotal/discount/tax/grand_total are DERIVED
-- (line items + discount_type/discount_value + tax_rate_bps) and are never
-- stored — see computeTotals in the domain service; client-supplied totals
-- are always ignored.
-- Down migration: DROP TABLE IN REVERSE ORDER (quote_line_items, quotes).

CREATE TABLE IF NOT EXISTS quotes (
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
  expires_at DATE,
  -- Cross-module references (plain uuid, no FK — see header).
  company_id UUID,
  person_id UUID,
  deal_id UUID,
  discount_type VARCHAR(16) NOT NULL DEFAULT 'none',
  discount_value INTEGER NOT NULL DEFAULT 0,
  tax_rate_bps INTEGER NOT NULL DEFAULT 0,
  terms TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS quotes_workspace_idx ON quotes (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS quotes_workspace_number_uidx
  ON quotes (workspace_id, number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS quotes_status_idx ON quotes (workspace_id, status);
CREATE INDEX IF NOT EXISTS quotes_company_idx ON quotes (company_id);
CREATE INDEX IF NOT EXISTS quotes_person_idx ON quotes (person_id);
CREATE INDEX IF NOT EXISTS quotes_deal_idx ON quotes (deal_id);
CREATE INDEX IF NOT EXISTS quotes_expires_at_idx ON quotes (workspace_id, expires_at);

CREATE TABLE IF NOT EXISTS quote_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  quote_id UUID NOT NULL REFERENCES quotes (id) ON DELETE CASCADE,
  -- Cross-module reference (plain uuid, no FK — see header).
  product_id UUID,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_amount_cents INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS quote_line_items_quote_idx ON quote_line_items (quote_id);
CREATE INDEX IF NOT EXISTS quote_line_items_workspace_idx ON quote_line_items (workspace_id);
CREATE INDEX IF NOT EXISTS quote_line_items_product_idx ON quote_line_items (product_id);
