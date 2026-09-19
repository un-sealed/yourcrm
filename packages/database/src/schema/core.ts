import { pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core"
import { baseColumns } from "./base"

/**
 * Tenancy root. Every business record carries a workspace_id FK here.
 *
 * This row is also the workspace *profile* the settings module edits
 * (spec 40): name, timezone, currency, date format and branding are columns
 * here rather than a parallel `workspace_settings` table, so there is exactly
 * one source of truth per workspace. `date_format`, `logo_url`, `brand_color`
 * and `support_email` were added by `0320_settings.sql`.
 */
export const workspaces = pgTable("workspaces", {
  ...baseColumns,
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 255 }).notNull().unique(),
  timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
  currency: varchar("currency", { length: 8 }).notNull().default("USD"),
  /** Display date format, token form (e.g. `YYYY-MM-DD`). */
  dateFormat: varchar("date_format", { length: 32 }).notNull().default("YYYY-MM-DD"),
  logoUrl: text("logo_url"),
  /** Branding accent colour, `#rrggbb`. */
  brandColor: varchar("brand_color", { length: 16 }),
  supportEmail: varchar("support_email", { length: 320 }),
})

export type Workspace = typeof workspaces.$inferSelect
export type NewWorkspace = typeof workspaces.$inferInsert

export const users = pgTable("users", {
  ...baseColumns,
  email: varchar("email", { length: 320 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  avatarUrl: text("avatar_url"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

/** Workspace membership (user <-> workspace with role). */
export const memberships = pgTable("memberships", {
  ...baseColumns,
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 32 }).notNull().default("member"),
})

export type Membership = typeof memberships.$inferSelect
export type NewMembership = typeof memberships.$inferInsert
