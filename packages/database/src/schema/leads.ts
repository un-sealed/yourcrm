import { index, integer, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Leads module tables (spec 08-leads, P0).
 *
 * - `leads`: one row per prospect. `person_id` / `company_id` / `deal_id`
 *   are PLAIN uuid columns with indexes and NO foreign keys — the target
 *   tables are owned by other (possibly not-yet-existing) modules, and
 *   cross-module foreign keys are added in a later integration pass.
 *   Conversion stores the target ids only; the wiring itself lands later.
 */

export const LEAD_STATUSES = ["new", "working", "qualified", "unqualified", "converted"] as const

export type LeadStatus = (typeof LEAD_STATUSES)[number]

export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === "string" && (LEAD_STATUSES as readonly string[]).includes(value)
}

export const LEAD_SOURCES = [
  "manual",
  "form",
  "meta",
  "google",
  "whatsapp",
  "indiamart",
  "justdial",
  "tradeindia",
] as const

export type LeadSource = (typeof LEAD_SOURCES)[number]

export function isLeadSource(value: unknown): value is LeadSource {
  return typeof value === "string" && (LEAD_SOURCES as readonly string[]).includes(value)
}

export const leads = pgTable(
  "leads",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    firstName: varchar("first_name", { length: 255 }).notNull(),
    lastName: varchar("last_name", { length: 255 }),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 64 }),
    companyName: varchar("company_name", { length: 255 }),
    title: varchar("title", { length: 255 }),
    source: varchar("source", { length: 32 }).notNull().default("manual"),
    status: varchar("status", { length: 32 }).notNull().default("new"),
    score: integer("score").notNull().default(0),
    notes: text("notes"),
    // Cross-module references (plain uuid, no FK — see module header).
    personId: uuid("person_id"),
    companyId: uuid("company_id"),
    dealId: uuid("deal_id"),
  },
  (t) => [
    index("leads_workspace_idx").on(t.workspaceId),
    index("leads_status_idx").on(t.workspaceId, t.status),
    index("leads_source_idx").on(t.workspaceId, t.source),
    index("leads_person_idx").on(t.personId),
    index("leads_company_idx").on(t.companyId),
    index("leads_deal_idx").on(t.dealId),
  ],
)

export type Lead = typeof leads.$inferSelect
export type NewLead = typeof leads.$inferInsert
