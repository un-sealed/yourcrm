-- 0080_products: Products module tables (spec 18-products, P0).
-- products + product_prices, following 0001_foundation.sql conventions
-- (base columns, IF NOT EXISTS, indexes beside tables).
-- SKU is unique per workspace (case-insensitive, live rows only).
-- product_prices.product_id is a same-module FK (safe: both tables are
-- created in this file); one live price row per (product, currency), stored
-- uppercase (ISO 4217).
-- Down migration: DROP TABLE IN REVERSE ORDER
-- (product_prices, products).

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  owner_id UUID,
  sku VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS products_workspace_idx ON products (workspace_id);
CREATE INDEX IF NOT EXISTS products_active_idx ON products (workspace_id, is_active);
CREATE INDEX IF NOT EXISTS products_name_idx ON products (workspace_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS products_workspace_sku_uidx
  ON products (workspace_id, lower(sku)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS product_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  currency VARCHAR(3) NOT NULL,
  unit_amount NUMERIC(14, 2) NOT NULL
);
CREATE INDEX IF NOT EXISTS product_prices_product_idx ON product_prices (product_id);
CREATE UNIQUE INDEX IF NOT EXISTS product_prices_product_currency_uidx
  ON product_prices (product_id, currency) WHERE deleted_at IS NULL;
