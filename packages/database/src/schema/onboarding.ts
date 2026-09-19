import { jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { baseColumns } from "./base"
import { workspaces } from "./core"

/**
 * Onboarding module table (spec 42-onboarding, P0).
 *
 * `onboarding_progress`: exactly one row per workspace (unique index on
 * `workspace_id`). This table stores no "step is done" boolean — the
 * onboarding domain service always recomputes step completion from real
 * data in people/deals/pipelines/memberships/workspaces (read-only). The
 * columns here only cache *when* the server first observed a step done
 * (`step_completed_at`) and track dismiss/reopen + sample-data bookkeeping,
 * none of which a client can use to assert a step complete.
 *
 * `sample_data` is a JSONB array of `{ module, recordId }` pairs identifying
 * rows the onboarding service created via other modules' own domain
 * services (never by writing to their tables directly), so demo data can be
 * found and removed later.
 */
export const onboardingProgress = pgTable(
  "onboarding_progress",
  {
    ...baseColumns,
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissedBy: uuid("dismissed_by"),
    /** Map of step key -> ISO timestamp first observed done. Server-only write. */
    stepCompletedAt: jsonb("step_completed_at").notNull().default({}),
    /** `{ module: string, recordId: string }[]` created by sample-data seeding. */
    sampleData: jsonb("sample_data").notNull().default([]),
    sampleDataSeededAt: timestamp("sample_data_seeded_at", { withTimezone: true }),
    sampleDataSeededBy: uuid("sample_data_seeded_by"),
  },
  (t) => [uniqueIndex("onboarding_progress_workspace_uidx").on(t.workspaceId)],
)

export type OnboardingProgressRow = typeof onboardingProgress.$inferSelect
export type NewOnboardingProgressRow = typeof onboardingProgress.$inferInsert
