import { isNull } from "drizzle-orm"
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, workspaceColumn } from "./base"

/**
 * Marketplace / Plugin SDK tables (spec 49-marketplace-sdk, P0).
 *
 * Three tables:
 *
 * - `marketplace_apps` — the catalogue. One row per published app manifest.
 *   Deliberately NOT workspace-scoped: a marketplace catalogue is shared
 *   across every workspace in this deployment, the same way the
 *   `@yourcrm/integrations` provider registry is process-wide rather than
 *   per-workspace (see `packages/integrations/src/registry.ts`). The
 *   difference is persistence: integration providers are vendor adapters
 *   registered in code at import time; marketplace apps are third-party
 *   manifests, so they are registered as data instead (`register()` in the
 *   domain service), reviewed, and installed per workspace from there. This
 *   is the one deliberate deviation from the "every table carries
 *   workspace_id" convention in this codebase — see DATA-MODEL-CONTRACTS.md
 *   "Universal record" and the note in `MARKETPLACE.md`.
 * - `app_installations` — one row per (workspace, app) install. Workspace
 *   scoped, `app_id` IS a real FK (this migration owns both tables).
 * - `app_scope_grants` — one row per (installation, object, action) scope
 *   actually granted. This table is the enforcement surface: an app can act
 *   only within the (object, action) pairs that have a live (non-revoked)
 *   row here. See `packages/crm/src/marketplace/access.ts`.
 *
 * `workspace_id`, `publisher_workspace_id`, `installed_by` and
 * `created_by`/`updated_by` are PLAIN uuid columns with NO foreign key,
 * following 0010_people.sql — even though `workspaces`/`users` are tables
 * this migration is allowed to reference, every other module keeps that
 * column plain, and this module follows the same convention for
 * consistency across migrations that apply in agent-parallel order.
 *
 * No code execution lands here. `manifest` is a validated, inert JSON
 * document (see `packages/crm/src/marketplace/schemas.ts`); nothing in this
 * package ever `eval`s or dynamically imports it.
 */

export const MARKETPLACE_APP_STATUSES = ["draft", "published", "deprecated"] as const
export type MarketplaceAppStatus = (typeof MARKETPLACE_APP_STATUSES)[number]

export const APP_INSTALLATION_STATUSES = ["active", "uninstalled"] as const
export type AppInstallationStatus = (typeof APP_INSTALLATION_STATUSES)[number]

export const marketplaceApps = pgTable(
  "marketplace_apps",
  {
    ...baseColumns,
    appKey: varchar("app_key", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    version: varchar("version", { length: 32 }).notNull(),
    publisher: varchar("publisher", { length: 255 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 32 }).notNull().default("published"),
    /** Full validated manifest: scopes, declared webhooks, UI extension points. */
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull().default({}),
    /** Which workspace registered this app, if any (plain, no FK — see header). */
    publisherWorkspaceId: uuid("publisher_workspace_id"),
  },
  (t) => [
    uniqueIndex("marketplace_apps_key_uidx").on(t.appKey).where(isNull(t.deletedAt)),
    index("marketplace_apps_status_idx").on(t.status),
  ],
)

export type MarketplaceAppRow = typeof marketplaceApps.$inferSelect
export type NewMarketplaceAppRow = typeof marketplaceApps.$inferInsert

export const appInstallations = pgTable(
  "app_installations",
  {
    ...baseColumns,
    ...workspaceColumn,
    appId: uuid("app_id")
      .notNull()
      .references(() => marketplaceApps.id, { onDelete: "cascade" }),
    appVersion: varchar("app_version", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    installedBy: uuid("installed_by"),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    uninstalledAt: timestamp("uninstalled_at", { withTimezone: true }),
  },
  (t) => [
    index("app_installations_workspace_idx").on(t.workspaceId),
    index("app_installations_app_idx").on(t.appId),
    // One ACTIVE install per (workspace, app). Reinstalling after an
    // uninstall is a fresh row — soft-deleted rows stay out of this index.
    uniqueIndex("app_installations_workspace_app_uidx")
      .on(t.workspaceId, t.appId)
      .where(isNull(t.deletedAt)),
  ],
)

export type AppInstallationRow = typeof appInstallations.$inferSelect
export type NewAppInstallationRow = typeof appInstallations.$inferInsert

export const appScopeGrants = pgTable(
  "app_scope_grants",
  {
    ...baseColumns,
    ...workspaceColumn,
    installationId: uuid("installation_id")
      .notNull()
      .references(() => appInstallations.id, { onDelete: "cascade" }),
    /** The CRM object the grant applies to, e.g. `"person"`, `"deal"`. */
    object: varchar("object", { length: 64 }).notNull(),
    /** One of `@yourcrm/permissions` `PERMISSION_ACTIONS`. */
    action: varchar("action", { length: 32 }).notNull(),
  },
  (t) => [
    index("app_scope_grants_workspace_idx").on(t.workspaceId),
    index("app_scope_grants_installation_idx").on(t.installationId),
    // A live (non-revoked) grant is unique per (installation, object, action);
    // revoking is a soft delete, so reinstalling can re-grant cleanly.
    uniqueIndex("app_scope_grants_unique_live_uidx")
      .on(t.installationId, t.object, t.action)
      .where(isNull(t.deletedAt)),
  ],
)

export type AppScopeGrantRow = typeof appScopeGrants.$inferSelect
export type NewAppScopeGrantRow = typeof appScopeGrants.$inferInsert
