import { and, asc, desc, eq, isNull, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  appInstallations,
  appScopeGrants,
  marketplaceApps,
  type AppInstallationRow,
  type AppScopeGrantRow,
  type MarketplaceAppRow,
} from "../schema/marketplace"
import { createBaseRepository } from "./base-repository"

/**
 * Marketplace / Plugin SDK repository (spec 49-marketplace-sdk, P0).
 *
 * Three concerns, one function each below:
 *  - the catalogue (`marketplaceApps` — no `workspace_id`, so it does NOT go
 *    through `createBaseRepository`, which assumes that column exists);
 *  - installations (workspace-scoped, wraps `createBaseRepository`);
 *  - scope grants (workspace-scoped, wraps `createBaseRepository`).
 *
 * No secrets, no crypto, no code execution — this module only ever persists
 * and reads back plain JSON manifests and (object, action) grant rows.
 */

export type CreateMarketplaceAppInput = {
  appKey: string
  name: string
  version: string
  publisher: string
  description?: string | null
  status?: string
  manifest: Record<string, unknown>
  publisherWorkspaceId?: string | null
}

export type MarketplaceAppListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  status?: string
}

const APP_STATUSES = ["draft", "published", "deprecated"] as const

function assertAppStatus(value: string): (typeof APP_STATUSES)[number] {
  if (!(APP_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`marketplace.apps: unknown status "${value}"`)
  }
  return value as (typeof APP_STATUSES)[number]
}

export function createMarketplaceRepository() {
  const installations = createBaseRepository(appInstallations)
  const grants = createBaseRepository(appScopeGrants)

  return {
    /* --------------------------- catalogue ---------------------------- */

    async listApps(db: Database, query: MarketplaceAppListQuery = {}) {
      const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
      const conditions: SQL[] = [isNull(marketplaceApps.deletedAt)]
      if (query.status) conditions.push(eq(marketplaceApps.status, assertAppStatus(query.status)))
      const ordering =
        query.order === "asc" ? asc(marketplaceApps.createdAt) : desc(marketplaceApps.createdAt)
      const rows = await db
        .select()
        .from(marketplaceApps)
        .where(and(...conditions))
        .orderBy(ordering)
        .limit(limit + 1)
      const hasMore = rows.length > limit
      const data = hasMore ? rows.slice(0, limit) : rows
      const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null
      return { data: data as MarketplaceAppRow[], pagination: { nextCursor, limit } }
    },

    async findAppById(db: Database, id: string): Promise<MarketplaceAppRow | null> {
      const rows = await db
        .select()
        .from(marketplaceApps)
        .where(and(eq(marketplaceApps.id, id), isNull(marketplaceApps.deletedAt)))
        .limit(1)
      return rows[0] ?? null
    },

    async findAppByKey(db: Database, appKey: string): Promise<MarketplaceAppRow | null> {
      const rows = await db
        .select()
        .from(marketplaceApps)
        .where(and(eq(marketplaceApps.appKey, appKey), isNull(marketplaceApps.deletedAt)))
        .limit(1)
      return rows[0] ?? null
    },

    async createApp(
      db: Database,
      input: CreateMarketplaceAppInput,
      actorId?: string,
    ): Promise<MarketplaceAppRow> {
      const rows = await db
        .insert(marketplaceApps)
        .values({
          appKey: input.appKey,
          name: input.name,
          version: input.version,
          publisher: input.publisher,
          description: input.description ?? null,
          status: assertAppStatus(input.status ?? "published"),
          manifest: input.manifest,
          publisherWorkspaceId: input.publisherWorkspaceId ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("marketplace.createApp: insert returned no rows")
      return row
    },

    /* -------------------------- installations -------------------------- */

    async listInstallations(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" },
    ) {
      const result = await installations.list(db, opts)
      return { data: result.data as AppInstallationRow[], pagination: result.pagination }
    },

    async findInstallationById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<AppInstallationRow | null> {
      const row = await installations.findById(db, workspaceId, id)
      return (row as AppInstallationRow | null) ?? null
    },

    /** Active (non-uninstalled) install of one app in one workspace, if any. */
    async findActiveInstallationByApp(
      db: Database,
      workspaceId: string,
      appId: string,
    ): Promise<AppInstallationRow | null> {
      const rows = await db
        .select()
        .from(appInstallations)
        .where(
          and(
            eq(appInstallations.workspaceId, workspaceId),
            eq(appInstallations.appId, appId),
            eq(appInstallations.status, "active"),
            isNull(appInstallations.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    async createInstallation(
      db: Database,
      workspaceId: string,
      input: { appId: string; appVersion: string; installedBy?: string | null },
      actorId?: string,
    ): Promise<AppInstallationRow> {
      const rows = await db
        .insert(appInstallations)
        .values({
          workspaceId,
          appId: input.appId,
          appVersion: input.appVersion,
          status: "active",
          installedBy: input.installedBy ?? null,
          installedAt: new Date(),
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("marketplace.createInstallation: insert returned no rows")
      return row
    },

    /** Marks 'uninstalled' and soft-deletes. Grants are revoked separately. */
    async uninstallInstallation(
      db: Database,
      workspaceId: string,
      id: string,
      actorId?: string,
    ): Promise<void> {
      await db
        .update(appInstallations)
        .set({
          status: "uninstalled",
          uninstalledAt: new Date(),
          deletedAt: new Date(),
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(and(eq(appInstallations.id, id), eq(appInstallations.workspaceId, workspaceId)))
    },

    /* ----------------------------- grants ------------------------------ */

    async listGrants(
      db: Database,
      workspaceId: string,
      installationId: string,
    ): Promise<AppScopeGrantRow[]> {
      const rows = await db
        .select()
        .from(appScopeGrants)
        .where(
          and(
            eq(appScopeGrants.workspaceId, workspaceId),
            eq(appScopeGrants.installationId, installationId),
            isNull(appScopeGrants.deletedAt),
          ),
        )
      return rows
    },

    async createGrants(
      db: Database,
      workspaceId: string,
      installationId: string,
      scopes: readonly { object: string; action: string }[],
      actorId?: string,
    ): Promise<AppScopeGrantRow[]> {
      if (scopes.length === 0) return []
      const rows = await db
        .insert(appScopeGrants)
        .values(
          scopes.map((scope) => ({
            workspaceId,
            installationId,
            object: scope.object,
            action: scope.action,
            ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
          })),
        )
        .returning()
      return rows
    },

    /** Revokes (soft-deletes) every live grant for one installation. */
    async revokeGrants(
      db: Database,
      workspaceId: string,
      installationId: string,
      actorId?: string,
    ): Promise<void> {
      await db
        .update(appScopeGrants)
        .set({
          deletedAt: new Date(),
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(
          and(
            eq(appScopeGrants.workspaceId, workspaceId),
            eq(appScopeGrants.installationId, installationId),
            isNull(appScopeGrants.deletedAt),
          ),
        )
    },

    grants,
    installations,
  }
}

export type MarketplaceRepository = ReturnType<typeof createMarketplaceRepository>
