-- 0260_knowledge_base: Knowledge Base module (spec 22-knowledge-base, P0).
-- kb_categories + kb_articles, following 0001_foundation.sql conventions
-- (base columns, IF NOT EXISTS, indexes beside tables).
--
-- category_id REFERENCES kb_categories: allowed because both tables are
-- created in THIS migration (same rule as person_emails.person_id in
-- 0010_people.sql). author_id is a PLAIN uuid column with an index and NO
-- foreign key, matching every other actor/owner column in the schema
-- (owner_id, created_by, updated_by) — none of them FK to users either.
--
-- kb_articles_slug_uidx / kb_categories_slug_uidx are PARTIAL unique indexes
-- (WHERE deleted_at IS NULL) so per-workspace slugs are unique among live
-- rows only, and a soft-deleted article's slug can be reused.
--
-- Draft/published visibility is enforced in the service layer
-- (packages/crm/src/knowledge-base/service.ts), not here: an unpublished
-- article must not be readable by anyone without edit permission.
--
-- Down migration: DROP TABLE IN REVERSE ORDER (kb_articles, kb_categories).

CREATE TABLE IF NOT EXISTS kb_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(160) NOT NULL,
  description TEXT
);
CREATE INDEX IF NOT EXISTS kb_categories_workspace_idx ON kb_categories (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS kb_categories_slug_uidx
  ON kb_categories (workspace_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS kb_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_by UUID,
  deleted_at TIMESTAMPTZ,
  workspace_id UUID NOT NULL,
  category_id UUID REFERENCES kb_categories (id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(160) NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  author_id UUID,
  published_at TIMESTAMPTZ,
  view_count INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT kb_articles_status_chk CHECK (status IN ('draft', 'published', 'archived'))
);
CREATE INDEX IF NOT EXISTS kb_articles_workspace_idx ON kb_articles (workspace_id);
CREATE INDEX IF NOT EXISTS kb_articles_status_idx ON kb_articles (workspace_id, status);
CREATE INDEX IF NOT EXISTS kb_articles_category_idx ON kb_articles (workspace_id, category_id);
CREATE INDEX IF NOT EXISTS kb_articles_author_idx ON kb_articles (workspace_id, author_id);
CREATE UNIQUE INDEX IF NOT EXISTS kb_articles_slug_uidx
  ON kb_articles (workspace_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS kb_articles_title_idx ON kb_articles (workspace_id, lower(title));
