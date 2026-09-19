import { createEvent, getEventBus, MarketplaceEvents } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import {
  assertAppScopeGranted,
  MARKETPLACE_APP_OBJECT,
  partitionScopesByInstallerPermission,
} from "./access"
import {
  appManifestSchema,
  installAppSchema,
  marketplaceAppQuerySchema,
  registerAppSchema,
} from "./schemas"
import type {
  AppInstallation,
  AppInstallationListResult,
  AppScope,
  AppScopeGrant,
  MarketplaceApp,
  MarketplaceAppListResult,
  MarketplaceServiceContext,
  MarketplaceServiceDeps,
} from "./types"

/* ---------------------------------- errors -------------------------------- */

export class MarketplaceAppNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`marketplace app ${id} not found`)
    this.name = "MarketplaceAppNotFoundError"
  }
}

export class AppInstallationNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`app installation ${id} not found`)
    this.name = "AppInstallationNotFoundError"
  }
}

export class AppKeyConflictError extends Error {
  readonly code = "CONFLICT"
  constructor(appKey: string) {
    super(`an app with id "${appKey}" is already registered`)
    this.name = "AppKeyConflictError"
  }
}

export class AppAlreadyInstalledError extends Error {
  readonly code = "CONFLICT"
  constructor(appKey: string) {
    super(`"${appKey}" is already installed in this workspace`)
    this.name = "AppAlreadyInstalledError"
  }
}

/* --------------------------------- helpers -------------------------------- */

function permissionOf(
  ctx: MarketplaceServiceContext,
  action: "read" | "create" | "admin",
  object: string = MARKETPLACE_APP_OBJECT,
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object,
    action,
  }
}

function manifestOf(app: MarketplaceApp): { scopes: AppScope[] } {
  const parsed = appManifestSchema.safeParse(app.manifest)
  if (!parsed.success) {
    throw new Error(`marketplace app ${app.id} has an invalid stored manifest`)
  }
  return { scopes: parsed.data.scopes.map((scope) => parseScopeString(scope)) }
}

function parseScopeString(scope: string): AppScope {
  const separatorIndex = scope.indexOf(":")
  return { object: scope.slice(0, separatorIndex), action: scope.slice(separatorIndex + 1) }
}

/**
 * Result of `install()`: the installation plus exactly which of the
 * manifest's requested scopes were granted vs. dropped for exceeding the
 * installer's own permissions. The caller (route/UI) surfaces `denied` so
 * consent stays legible — an app silently missing a capability it asked for
 * is a worse experience than an explicit "your role couldn't grant this".
 */
export type InstallAppResult = {
  installation: AppInstallation
  grantedScopes: AppScope[]
  deniedScopes: AppScope[]
}

/**
 * Marketplace / Plugin SDK domain service (spec 49-marketplace-sdk, P0).
 *
 * Every method calls `requirePermission()` first. `install` and `uninstall`
 * require `admin` (spec §8: "workspace admin; app scopes constrained").
 * Catalogue reads (`listApps`, `getApp`) and installed-app reads
 * (`listInstallations`, `getInstallation`) only need `read` — browsing the
 * marketplace is not a privileged action.
 *
 * NOT BUILT IN P0 — READ BEFORE EXTENDING
 * ----------------------------------------
 * There is no plugin runtime here: no sandbox, no `eval`, no dynamic
 * `import()` of remote code, no iframe host. `install()` never executes
 * anything from the manifest — it validates it, computes a capped grant
 * set, and persists rows. A P0 "app" IS its manifest plus its
 * `app_scope_grants` rows; nothing else exists at runtime.
 *
 * A future phase that adds actual app code (a `run()` hook, a hosted
 * function, a webhook DELIVERY worker) needs, at minimum: (1) execution in
 * an isolated process/container per invocation, not in the API process —
 * an app must not share a heap, filesystem or outbound network path with
 * the platform; (2) every domain-service call the app code makes routed
 * through `assertAppScopeGranted` from `./access.ts` (do not invent a
 * second gate); (3) a hard wall-clock and memory budget per invocation,
 * enforced by the sandbox, not the app; (4) no ambient credentials — a
 * scoped, short-lived token minted per invocation, naming the installation
 * and nothing else the app could exfiltrate and replay.
 */
export function createMarketplaceService(deps: MarketplaceServiceDeps) {
  const events = deps.events ?? getEventBus()

  async function listApps(
    ctx: MarketplaceServiceContext,
    rawQuery: unknown,
  ): Promise<MarketplaceAppListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = marketplaceAppQuerySchema.parse(rawQuery)
    return deps.apps.list(query)
  }

  async function getApp(ctx: MarketplaceServiceContext, id: string): Promise<MarketplaceApp> {
    requirePermission(permissionOf(ctx, "read"))
    const app = await deps.apps.findById(id)
    if (!app) throw new MarketplaceAppNotFoundError(id)
    return app
  }

  /**
   * Publish a manifest to the catalogue. Gated `admin`: this deployment's
   * marketplace has no separate developer-review workflow in P0 (spec
   * priorities put full review/publishing in a later phase) — whoever can
   * register an app can already act as workspace admin.
   */
  async function registerApp(
    ctx: MarketplaceServiceContext,
    rawInput: unknown,
  ): Promise<MarketplaceApp> {
    requirePermission(permissionOf(ctx, "admin"))
    const input = registerAppSchema.parse(rawInput)
    const existing = await deps.apps.findByAppKey(input.manifest.id)
    if (existing) throw new AppKeyConflictError(input.manifest.id)
    const app = await deps.apps.create(
      {
        appKey: input.manifest.id,
        name: input.manifest.name,
        version: input.manifest.version,
        publisher: input.manifest.publisher,
        description: input.manifest.description ?? null,
        status: input.status,
        manifest: input.manifest,
        publisherWorkspaceId: ctx.workspaceId,
      },
      ctx.actorId,
    )
    await events.emit(
      createEvent({
        event: MarketplaceEvents.AppRegistered,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "marketplace_app",
        entityId: app.id,
        after: app,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "marketplace_app",
      recordId: app.id,
      after: app,
      correlationId: ctx.correlationId,
    })
    return app
  }

  async function listInstallations(
    ctx: MarketplaceServiceContext,
    rawQuery: unknown,
  ): Promise<AppInstallationListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = marketplaceAppQuerySchema
      .pick({ limit: true, cursor: true, order: true })
      .parse(rawQuery)
    return deps.installations.list(ctx.workspaceId, query)
  }

  async function getInstallation(
    ctx: MarketplaceServiceContext,
    id: string,
  ): Promise<{ installation: AppInstallation; grants: AppScopeGrant[] }> {
    requirePermission(permissionOf(ctx, "read"))
    const installation = await deps.installations.findById(ctx.workspaceId, id)
    if (!installation) throw new AppInstallationNotFoundError(id)
    const grants = await deps.grants.listByInstallation(ctx.workspaceId, id)
    return { installation, grants }
  }

  /**
   * Install one app into this workspace. Scopes actually granted are the
   * requested set narrowed by the INSTALLING USER's own permissions
   * (`partitionScopesByInstallerPermission`, `./access.ts`) — never the
   * full manifest request, and never more than what that user could do by
   * hand. Denied scopes are reported back, not silently dropped from view.
   */
  async function install(
    ctx: MarketplaceServiceContext,
    appId: string,
    rawInput: unknown = {},
  ): Promise<InstallAppResult> {
    requirePermission(permissionOf(ctx, "admin"))
    installAppSchema.parse(rawInput)

    const app = await deps.apps.findById(appId)
    if (!app || app.status !== "published") throw new MarketplaceAppNotFoundError(appId)

    const existing = await deps.installations.findActiveByApp(ctx.workspaceId, app.id)
    if (existing) throw new AppAlreadyInstalledError(app.appKey)

    const { scopes: requestedScopes } = manifestOf(app)
    const { granted, denied } = partitionScopesByInstallerPermission(ctx, requestedScopes)

    const installation = await deps.installations.create(
      ctx.workspaceId,
      { appId: app.id, appVersion: app.version, installedBy: ctx.actorId },
      ctx.actorId,
    )
    const grants = await deps.grants.createMany(
      ctx.workspaceId,
      installation.id,
      granted,
      ctx.actorId,
    )

    await events.emit(
      createEvent({
        event: MarketplaceEvents.AppInstalled,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "app_installation",
        entityId: installation.id,
        after: { installation, grantedScopes: granted, deniedScopes: denied },
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "install",
      object: "app_installation",
      recordId: installation.id,
      after: { appId: app.id, appKey: app.appKey, grants, deniedScopes: denied },
      correlationId: ctx.correlationId,
    })

    if (denied.length > 0) {
      await events.emit(
        createEvent({
          event: MarketplaceEvents.AppScopeDenied,
          workspaceId: ctx.workspaceId,
          actorId: ctx.actorId,
          entityType: "app_installation",
          entityId: installation.id,
          after: { deniedScopes: denied },
          correlationId: ctx.correlationId,
        }),
      )
    }

    return { installation, grantedScopes: granted, deniedScopes: denied }
  }

  /**
   * Uninstall: revoke every grant, then soft-delete the installation. No
   * grant row for this installation stays live — a re-install starts from
   * zero and recomputes grants from scratch.
   */
  async function uninstall(ctx: MarketplaceServiceContext, installationId: string): Promise<void> {
    requirePermission(permissionOf(ctx, "admin"))
    const installation = await deps.installations.findById(ctx.workspaceId, installationId)
    if (!installation || installation.status !== "active") {
      throw new AppInstallationNotFoundError(installationId)
    }

    await deps.grants.revokeAll(ctx.workspaceId, installation.id, ctx.actorId)
    await deps.installations.uninstall(ctx.workspaceId, installation.id, ctx.actorId)

    await events.emit(
      createEvent({
        event: MarketplaceEvents.AppUninstalled,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "app_installation",
        entityId: installation.id,
        before: installation,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "uninstall",
      object: "app_installation",
      recordId: installation.id,
      before: installation,
      correlationId: ctx.correlationId,
    })
  }

  /**
   * Run-time scope check: may the app behind `installationId` do
   * `action` on `object` right now? Loads the live grants and delegates to
   * `assertAppScopeGranted` (`./access.ts`) — the single enforcement point
   * every future "act as this app" call site must go through. Throws
   * `PermissionDeniedError` (mapped to 403 by the route layer) on denial.
   */
  async function assertScope(
    ctx: MarketplaceServiceContext,
    installationId: string,
    object: string,
    action: string,
  ): Promise<void> {
    const installation = await deps.installations.findById(ctx.workspaceId, installationId)
    if (!installation || installation.status !== "active") {
      throw new AppInstallationNotFoundError(installationId)
    }
    const grants = await deps.grants.listByInstallation(ctx.workspaceId, installationId)
    assertAppScopeGranted(
      { workspaceId: ctx.workspaceId, installationId: installation.id },
      grants,
      object,
      action,
    )
  }

  return {
    listApps,
    getApp,
    registerApp,
    listInstallations,
    getInstallation,
    install,
    uninstall,
    assertScope,
  }
}

export type MarketplaceService = ReturnType<typeof createMarketplaceService>
