import { isNull, sql } from "drizzle-orm"
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, workspaceColumn } from "./base"

/**
 * Knowledge Base module tables (spec 22-knowledge-base, P0).
 *
 * - `kb_categories`: simple per-workspace grouping for articles.
 * - `kb_articles`: one row per article. `body` is the markdown SOURCE TEXT —
 *   P0 renders it as plain/escaped text on the client (see
 *   `apps/web/app/app/knowledge-base`), never as trusted HTML, and no
 *   markdown/sanitizer dependency is added (out of scope: this agent may not
 *   edit package.json). `category_id` FKs to `kb_categories` because both
 *   tables are created in THIS migration — the one FK shape the repo allows
 *   besides `workspaces`/`users` (see 0260_knowledge_base.sql header).
 *   `author_id` is a PLAIN uuid column with an index and NO foreign key,
 *   mirroring every other actor/owner column in the schema (`ownerColumn`,
 *   `createdBy`/`updatedBy`) — none of them FK to `users` either.
 *
 * Draft/published visibility is a SERVICE-layer rule
 * (`packages/crm/src/knowledge-base/service.ts`), not a DDL constraint: an
 * unpublished article must not be readable by anyone without edit
 * permission. `status` stays a plain checked varchar so the rule can change
 * without a migration.
 */

export const KB_ARTICLE_STATUSES = ["draft", "published", "archived"] as const

export type KbArticleStatus = (typeof KB_ARTICLE_STATUSES)[number]

export function isKbArticleStatus(value: unknown): value is KbArticleStatus {
  return typeof value === "string" && (KB_ARTICLE_STATUSES as readonly string[]).includes(value)
}

export const kbCategories = pgTable(
  "kb_categories",
  {
    ...baseColumns,
    ...workspaceColumn,
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 160 }).notNull(),
    description: text("description"),
  },
  (t) => [
    index("kb_categories_workspace_idx").on(t.workspaceId),
    uniqueIndex("kb_categories_slug_uidx").on(t.workspaceId, t.slug).where(isNull(t.deletedAt)),
  ],
)

export type KbCategory = typeof kbCategories.$inferSelect
export type NewKbCategory = typeof kbCategories.$inferInsert

export const kbArticles = pgTable(
  "kb_articles",
  {
    ...baseColumns,
    ...workspaceColumn,
    categoryId: uuid("category_id").references(() => kbCategories.id, { onDelete: "set null" }),
    title: varchar("title", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 160 }).notNull(),
    body: text("body").notNull().default(""),
    status: varchar("status", { length: 16 }).notNull().default("draft"),
    authorId: uuid("author_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    viewCount: integer("view_count").notNull().default(0),
  },
  (t) => [
    index("kb_articles_workspace_idx").on(t.workspaceId),
    index("kb_articles_status_idx").on(t.workspaceId, t.status),
    index("kb_articles_category_idx").on(t.workspaceId, t.categoryId),
    index("kb_articles_author_idx").on(t.workspaceId, t.authorId),
    uniqueIndex("kb_articles_slug_uidx").on(t.workspaceId, t.slug).where(isNull(t.deletedAt)),
    index("kb_articles_title_idx").on(t.workspaceId, sql`lower(${t.title})`),
  ],
)

export type KbArticle = typeof kbArticles.$inferSelect
export type NewKbArticle = typeof kbArticles.$inferInsert
