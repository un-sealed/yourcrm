import {
  boolean,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Customer Success module tables (spec 46-customer-success, P0).
 * Migration `0300_customer_success.sql`.
 *
 * - `cs_accounts`: a customer-success VIEW over a company — not a second
 *   companies table. `company_id` is a PLAIN uuid column with an index and
 *   NO foreign key (same rule as `people.company_id`): the companies module
 *   is owned by another agent. `owner_id` (the CSM) is likewise a plain,
 *   unconstrained uuid — same convention as `owner_id` everywhere else in
 *   the repo (see `unified-inbox.ts` header).
 * - `cs_health_scores`: one row PER COMPUTATION, never overwritten. A score
 *   is "recorded as data, not recomputed ad hoc in the UI" — `factors` is
 *   the explainable breakdown that produced `score`, stored verbatim at
 *   compute time. History lets a CSM see the trend, not just the latest
 *   number.
 * - `cs_renewals`: upcoming renewal tracking with a risk flag and an owner.
 * - `cs_playbook_tasks`: the LINK between a named playbook run and the real
 *   task rows it created. It intentionally does not restate task fields
 *   (title, status, due date, assignee) — those live in `tasks`, owned by
 *   the tasks module. `task_id` is a PLAIN uuid, NO foreign key, created
 *   through the tasks module's own service (`TasksPort` in
 *   `@yourcrm/crm/src/customer-success`), so this module never re-implements
 *   a task engine. `playbook_key` is validated against the allowlist in
 *   `repositories/customer-success-repository.ts` (`CS_PLAYBOOKS`), never a
 *   free-form string.
 *
 * All cross-table references INSIDE this module (health scores / renewals /
 * playbook tasks -> accounts) use real foreign keys with `ON DELETE CASCADE`
 * — the hard rule against FKs is about tables this module does not own, not
 * about its own tables in the same migration file.
 */

export const CS_LIFECYCLE_STAGES = [
  "onboarding",
  "adopting",
  "healthy",
  "at_risk",
  "churned",
] as const

export type CsLifecycleStage = (typeof CS_LIFECYCLE_STAGES)[number]

export function isCsLifecycleStage(value: unknown): value is CsLifecycleStage {
  return typeof value === "string" && (CS_LIFECYCLE_STAGES as readonly string[]).includes(value)
}

export const CS_RENEWAL_STATUSES = ["open", "won", "lost"] as const

export type CsRenewalStatus = (typeof CS_RENEWAL_STATUSES)[number]

export function isCsRenewalStatus(value: unknown): value is CsRenewalStatus {
  return typeof value === "string" && (CS_RENEWAL_STATUSES as readonly string[]).includes(value)
}

export const csAccounts = pgTable(
  "cs_accounts",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    // Plain uuid, no FK — companies is owned by another module agent.
    companyId: uuid("company_id").notNull(),
    lifecycleStage: varchar("lifecycle_stage", { length: 32 }).notNull().default("onboarding"),
    arr: numeric("arr", { precision: 14, scale: 2 }),
    renewalDate: date("renewal_date"),
    notes: text("notes"),
  },
  (t) => [
    index("cs_accounts_workspace_idx").on(t.workspaceId),
    index("cs_accounts_company_idx").on(t.companyId),
    index("cs_accounts_owner_idx").on(t.workspaceId, t.ownerId),
    index("cs_accounts_lifecycle_idx").on(t.workspaceId, t.lifecycleStage),
    index("cs_accounts_renewal_date_idx").on(t.workspaceId, t.renewalDate),
    // One CS account per company per workspace (live rows only).
    uniqueIndex("cs_accounts_workspace_company_uidx").on(t.workspaceId, t.companyId),
  ],
)

export type CsAccount = typeof csAccounts.$inferSelect
export type NewCsAccount = typeof csAccounts.$inferInsert

export const csHealthScores = pgTable(
  "cs_health_scores",
  {
    ...baseColumns,
    ...workspaceColumn,
    accountId: uuid("account_id")
      .notNull()
      .references(() => csAccounts.id, { onDelete: "cascade" }),
    score: numeric("score", { precision: 5, scale: 2 }).notNull(),
    // [{ key, label, rawValue, normalizedScore, weight, contribution }],
    // computed server-side from the allowlisted factor registry in
    // repositories/customer-success-repository.ts. Never user-supplied.
    factors: jsonb("factors").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    // Actor who triggered the computation; plain uuid, no FK (see header).
    computedBy: uuid("computed_by"),
  },
  (t) => [
    index("cs_health_scores_workspace_idx").on(t.workspaceId),
    index("cs_health_scores_account_computed_idx").on(t.accountId, t.computedAt),
  ],
)

export type CsHealthScore = typeof csHealthScores.$inferSelect
export type NewCsHealthScore = typeof csHealthScores.$inferInsert

export const csRenewals = pgTable(
  "cs_renewals",
  {
    ...baseColumns,
    ...workspaceColumn,
    accountId: uuid("account_id")
      .notNull()
      .references(() => csAccounts.id, { onDelete: "cascade" }),
    renewalDate: date("renewal_date").notNull(),
    arr: numeric("arr", { precision: 14, scale: 2 }),
    // Renewal owner; plain uuid, no FK (see header).
    ownerId: uuid("owner_id"),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    riskFlag: boolean("risk_flag").notNull().default(false),
    notes: text("notes"),
  },
  (t) => [
    index("cs_renewals_workspace_idx").on(t.workspaceId),
    index("cs_renewals_account_idx").on(t.accountId),
    index("cs_renewals_renewal_date_idx").on(t.workspaceId, t.renewalDate),
    index("cs_renewals_owner_idx").on(t.workspaceId, t.ownerId),
    index("cs_renewals_risk_idx").on(t.workspaceId, t.riskFlag),
  ],
)

export type CsRenewal = typeof csRenewals.$inferSelect
export type NewCsRenewal = typeof csRenewals.$inferInsert

export const csPlaybookTasks = pgTable(
  "cs_playbook_tasks",
  {
    ...baseColumns,
    ...workspaceColumn,
    accountId: uuid("account_id")
      .notNull()
      .references(() => csAccounts.id, { onDelete: "cascade" }),
    // Validated against the `CS_PLAYBOOKS` allowlist — never freeform.
    playbookKey: varchar("playbook_key", { length: 64 }).notNull(),
    // tasks.id, owned by the tasks module. Plain uuid, NO foreign key — the
    // row is created through TasksPort (the tasks module's own service),
    // never written to directly. See module header.
    taskId: uuid("task_id").notNull(),
    appliedBy: uuid("applied_by"),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cs_playbook_tasks_workspace_idx").on(t.workspaceId),
    index("cs_playbook_tasks_account_idx").on(t.accountId),
    index("cs_playbook_tasks_playbook_idx").on(t.workspaceId, t.playbookKey),
    uniqueIndex("cs_playbook_tasks_task_uidx").on(t.workspaceId, t.taskId),
  ],
)

export type CsPlaybookTask = typeof csPlaybookTasks.$inferSelect
export type NewCsPlaybookTask = typeof csPlaybookTasks.$inferInsert
