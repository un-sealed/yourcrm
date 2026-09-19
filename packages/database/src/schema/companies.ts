import { isNull, sql } from "drizzle-orm"
import { boolean, index, pgTable, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Companies module tables (spec 07-companies, P0).
 *
 * - `companies`: one row per account. `parent_company_id` is a plain uuid
 *   self-column with an index and NO foreign key (same rule as
 *   `people.company_id`): the hierarchy is validated in the repository
 *   (parent must exist, a company cannot be its own parent), keeping the
 *   migration additive and free of self-referential DDL ordering issues.
 * - `company_addresses`: multiple locations per company, exactly one primary
 *   each (enforced by the repository, not DDL, so bulk imports can land
 *   before choosing a primary).
 * - Cross-module reference: `people.company_id` points here as a plain uuid
 *   column with NO foreign key (owned by the people module); the matching
 *   foreign keys across modules are added in a later integration pass.
 */

export const COMPANY_STATUSES = ["active", "archived"] as const

export type CompanyStatus = (typeof COMPANY_STATUSES)[number]

export function isCompanyStatus(value: unknown): value is CompanyStatus {
  return typeof value === "string" && (COMPANY_STATUSES as readonly string[]).includes(value)
}

export const companies = pgTable(
  "companies",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    name: varchar("name", { length: 255 }).notNull(),
    domain: varchar("domain", { length: 255 }),
    website: varchar("website", { length: 1024 }),
    industry: varchar("industry", { length: 128 }),
    size: varchar("size", { length: 64 }),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    description: text("description"),
    // Plain uuid self-column (no FK): hierarchy validated in the repository.
    // `people.company_id` points here the same way from the people module.
    parentCompanyId: uuid("parent_company_id"),
  },
  (t) => [
    index("companies_workspace_idx").on(t.workspaceId),
    index("companies_parent_idx").on(t.parentCompanyId),
    index("companies_status_idx").on(t.workspaceId, t.status),
    index("companies_industry_idx").on(t.workspaceId, t.industry),
    index("companies_name_idx").on(t.workspaceId, sql`lower(${t.name})`),
    index("companies_domain_idx").on(t.workspaceId, sql`lower(${t.domain})`),
  ],
)

export type Company = typeof companies.$inferSelect
export type NewCompany = typeof companies.$inferInsert

export const companyAddresses = pgTable(
  "company_addresses",
  {
    ...baseColumns,
    ...workspaceColumn,
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 64 }),
    line1: varchar("line1", { length: 255 }),
    city: varchar("city", { length: 128 }),
    region: varchar("region", { length: 128 }),
    postalCode: varchar("postal_code", { length: 32 }),
    country: varchar("country", { length: 128 }),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (t) => [
    index("company_addresses_company_idx").on(t.companyId),
    uniqueIndex("company_addresses_company_label_uidx")
      .on(t.companyId, sql`lower(${t.label})`)
      .where(isNull(t.deletedAt)),
  ],
)

export type CompanyAddress = typeof companyAddresses.$inferSelect
export type NewCompanyAddress = typeof companyAddresses.$inferInsert
