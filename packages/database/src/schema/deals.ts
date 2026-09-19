import { index, numeric, pgTable, text, varchar, date, integer, uuid } from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Deals module tables (spec 09-deals, P0).
 *
 * - `deals`: one row per revenue opportunity. `pipeline_id` / `stage_id`
 *   are PLAIN uuid columns with indexes and NO foreign keys — the pipelines
 *   tables do not exist yet and are created by a later module agent (same
 *   rule as people.company_id). `person_id` / `company_id` are likewise
 *   plain uuid references to tables owned by other agents.
 * - `stage` is the kanban grouping key (a stable machine string); `stage_id`
 *   optionally points at a pipeline-owned stage row for later joins.
 * - `amount` is NUMERIC(14,2); `weighted value` (amount * probability / 100)
 *   is derived, never stored.
 */

export const DEAL_STAGES = [
  "qualification",
  "discovery",
  "proposal",
  "negotiation",
  "won",
  "lost",
] as const

export type DealStage = (typeof DEAL_STAGES)[number]

export function isDealStage(value: unknown): value is DealStage {
  return typeof value === "string" && (DEAL_STAGES as readonly string[]).includes(value)
}

export const OPEN_DEAL_STAGES: readonly DealStage[] = [
  "qualification",
  "discovery",
  "proposal",
  "negotiation",
]

export function isOpenDealStage(value: unknown): boolean {
  return typeof value === "string" && (OPEN_DEAL_STAGES as readonly string[]).includes(value)
}

export const deals = pgTable(
  "deals",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    name: varchar("name", { length: 255 }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    pipelineId: uuid("pipeline_id"),
    stageId: uuid("stage_id"),
    stage: varchar("stage", { length: 64 }).notNull().default("qualification"),
    probability: integer("probability"),
    expectedCloseDate: date("expected_close_date"),
    personId: uuid("person_id"),
    companyId: uuid("company_id"),
    closeReason: varchar("close_reason", { length: 255 }),
    notes: text("notes"),
  },
  (t) => [
    index("deals_workspace_idx").on(t.workspaceId),
    index("deals_stage_idx").on(t.workspaceId, t.stage),
    index("deals_pipeline_idx").on(t.pipelineId),
    index("deals_stage_ref_idx").on(t.stageId),
    index("deals_person_idx").on(t.personId),
    index("deals_company_idx").on(t.companyId),
    index("deals_close_date_idx").on(t.workspaceId, t.expectedCloseDate),
  ],
)

export type Deal = typeof deals.$inferSelect
export type NewDeal = typeof deals.$inferInsert
