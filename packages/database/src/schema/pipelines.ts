import { boolean, index, integer, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Pipelines module tables (spec 10-pipelines, P0).
 *
 * - `pipelines`: one row per reusable sales/process pipeline. Workspace
 *   scoped, soft-delete aware, exactly like `people`.
 * - `pipeline_stages`: ordered stages belonging to one pipeline.
 *   `pipeline_id` references `pipelines (id)` (same-module FK, safe) with
 *   cascade delete. `position` is a dense 0-based order maintained by the
 *   repository; `probability` is a 0-100 win likelihood; `is_won` / `is_lost`
 *   mark terminal stages. A stage must never be both won and lost.
 *
 * Cross-module references (deals pointing at a pipeline/stage) are plain
 * `uuid` columns owned by the deals module — no FK here, per the module
 * boundary rule (same as `people.company_id`).
 */

export const PIPELINE_STATUSES = ["active", "archived"] as const

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number]

export function isPipelineStatus(value: unknown): value is PipelineStatus {
  return typeof value === "string" && (PIPELINE_STATUSES as readonly string[]).includes(value)
}

export const pipelines = pgTable(
  "pipelines",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    isDefault: boolean("is_default").notNull().default(false),
  },
  (t) => [
    index("pipelines_workspace_idx").on(t.workspaceId),
    index("pipelines_status_idx").on(t.workspaceId, t.status),
  ],
)

export type Pipeline = typeof pipelines.$inferSelect
export type NewPipeline = typeof pipelines.$inferInsert

export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    ...baseColumns,
    ...workspaceColumn,
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    color: varchar("color", { length: 32 }),
    position: integer("position").notNull().default(0),
    probability: integer("probability").notNull().default(0),
    isWon: boolean("is_won").notNull().default(false),
    isLost: boolean("is_lost").notNull().default(false),
  },
  (t) => [
    index("pipeline_stages_pipeline_idx").on(t.pipelineId),
    index("pipeline_stages_position_idx").on(t.pipelineId, t.position),
  ],
)

export type PipelineStage = typeof pipelineStages.$inferSelect
export type NewPipelineStage = typeof pipelineStages.$inferInsert

/**
 * Seed definition for the default sales pipeline, so the Deals module has
 * something to point at. Workspace-scoped rows cannot live in a migration
 * (there is no workspace to attach them to), so the pipelines service
 * creates them on demand via `ensureDefaultPipeline()` from this constant.
 */
export const DEFAULT_SALES_PIPELINE = {
  name: "Sales Pipeline",
  description: "Default sales process: prospect to close.",
  stages: [
    { name: "Prospecting", probability: 10 },
    { name: "Qualification", probability: 25 },
    { name: "Proposal", probability: 60 },
    { name: "Negotiation", probability: 80 },
    { name: "Closed Won", probability: 100, isWon: true },
    { name: "Closed Lost", probability: 0, isLost: true },
  ],
} as const
