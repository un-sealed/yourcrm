import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Marketplace / Plugin SDK ports (spec 49-marketplace-sdk, P0).
 *
 * ## Relationship to `@yourcrm/integrations`
 *
 * This module does NOT invent a second extension model. It reuses the same
 * shape `packages/integrations/src/provider.ts` already established —
 * a typed, self-describing unit of "a third party YourCRM talks to" plus a
 * registry — and widens it along exactly the axis a marketplace app needs
 * that a vendor connector does not: a declared, enforced **scope** grant
 * instead of an all-or-nothing "connected" credential.
 *
 * Where they differ, and why:
 *  - An `IntegrationProvider` is code, shipped with this deployment,
 *    registered into a process-wide registry at import time
 *    (`registerIntegrationProvider`). A `MarketplaceApp` is DATA — a
 *    developer-submitted manifest, persisted in `marketplace_apps` — because
 *    P0 explicitly does not execute third-party code (no plugin runtime, no
 *    sandbox, no `eval`, no dynamic `import()`). There is nothing to
 *    "register at import time" for a manifest with no code.
 *  - An `IntegrationProvider` connects with a secret and gets
 *    `IntegrationCapability[]` — a fixed vocabulary of what it can DO.
 *    A `MarketplaceApp` requests `AppScope[]` — WHICH (object, action)
 *    pairs of the *existing permission model* it wants — because a
 *    marketplace app acts on this workspace's CRM data through the same
 *    `requirePermission()` gate every domain service already uses, not
 *    through a bespoke capability list.
 *  - Both share the install/uninstall-per-workspace lifecycle
 *    (`integration_connections` / `app_installations`), the audit-on-every-
 *    mutation rule, and the "the registry/catalogue is the single source of
 *    truth, nothing hardcodes a vendor or app list" principle.
 *
 * A later phase that DOES add code execution should keep this contract and
 * add a sandboxed `run()` hook gated by the SAME `app_scope_grants` table —
 * not a parallel permission system. See the "NOT BUILT IN P0" note at the
 * bottom of `service.ts`.
 *
 * ## Store ports
 *
 * `@yourcrm/crm` has no database dependency, so the service talks to the
 * structural stores below; `apps/api` adapts
 * `@yourcrm/database/src/repositories/marketplace-repository` to them, and
 * hermetic tests satisfy them with in-memory fakes (see `../ports.ts` for
 * why `AuditWriter`/`EventEmitter` live there instead of here).
 */

/* -------------------------------- scopes -------------------------------- */

/**
 * One requested or granted permission slice: "this app wants to `action` on
 * `object`" — e.g. `{ object: "person", action: "read" }`. `action` is one
 * of `@yourcrm/permissions`' `PERMISSION_ACTIONS`; `object` names a CRM
 * object (e.g. `person`, `deal`, `company` — see `SEARCH_OBJECT_TYPES` in
 * `../search/types.ts` for the known set, not enforced as a closed list
 * here so a later module's object is never blocked at the schema layer).
 */
export type AppScope = {
  object: string
  action: string
}

/** Declared inline in the manifest: which domain events the app wants delivered. */
export type AppWebhookDeclaration = {
  event: string
  description?: string | null
}

/** Declared inline in the manifest: where in the UI the app wants a slot. */
export type AppUiExtensionDeclaration = {
  location: string
  label: string
}

/**
 * The validated manifest shape, persisted verbatim in
 * `marketplace_apps.manifest`. `scopes` is the WIRE format —
 * `"<object>:<action>"` strings, e.g. `"person:read"` (see
 * `appScopeStringSchema` / `parseAppScope` in `./schemas.ts`) — not the
 * parsed `AppScope` object form, which only exists after
 * `parseAppScope()`.
 */
export type AppManifest = {
  id: string
  name: string
  version: string
  publisher: string
  description?: string | null
  scopes: string[]
  webhooks: AppWebhookDeclaration[]
  uiExtensionPoints: AppUiExtensionDeclaration[]
  docsUrl?: string | null
}

/* ------------------------------- records -------------------------------- */

export const MARKETPLACE_APP_STATUSES = ["draft", "published", "deprecated"] as const
export type MarketplaceAppStatusValue = (typeof MARKETPLACE_APP_STATUSES)[number]

export const APP_INSTALLATION_STATUSES = ["active", "uninstalled"] as const
export type AppInstallationStatusValue = (typeof APP_INSTALLATION_STATUSES)[number]

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type MarketplaceApp = Record<string, unknown> & {
  id: string
  appKey: string
  name: string
  version: string
  publisher: string
  status: string
  manifest: Record<string, unknown>
}

export type AppInstallation = Record<string, unknown> & {
  id: string
  workspaceId: string
  appId: string
  appVersion: string
  status: string
}

export type AppScopeGrant = Record<string, unknown> & {
  id: string
  workspaceId: string
  installationId: string
  object: string
  action: string
}

export type MarketplaceAppListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  status?: string
}

export type MarketplaceAppListResult = {
  data: MarketplaceApp[]
  pagination: { nextCursor: string | null; limit: number }
}

export type AppInstallationListResult = {
  data: AppInstallation[]
  pagination: { nextCursor: string | null; limit: number }
}

/* -------------------------------- stores -------------------------------- */

export type MarketplaceAppStore = {
  list(query: MarketplaceAppListQuery): Promise<MarketplaceAppListResult>
  findById(id: string): Promise<MarketplaceApp | null>
  findByAppKey(appKey: string): Promise<MarketplaceApp | null>
  create(input: Record<string, unknown>, actorId?: string): Promise<MarketplaceApp>
}

export type AppInstallationStore = {
  list(
    workspaceId: string,
    query: { limit?: number; cursor?: string; order?: "asc" | "desc" },
  ): Promise<AppInstallationListResult>
  findById(workspaceId: string, id: string): Promise<AppInstallation | null>
  findActiveByApp(workspaceId: string, appId: string): Promise<AppInstallation | null>
  create(
    workspaceId: string,
    input: { appId: string; appVersion: string; installedBy?: string | null },
    actorId?: string,
  ): Promise<AppInstallation>
  uninstall(workspaceId: string, id: string, actorId?: string): Promise<void>
}

export type AppScopeGrantStore = {
  listByInstallation(workspaceId: string, installationId: string): Promise<AppScopeGrant[]>
  createMany(
    workspaceId: string,
    installationId: string,
    scopes: readonly AppScope[],
    actorId?: string,
  ): Promise<AppScopeGrant[]>
  revokeAll(workspaceId: string, installationId: string, actorId?: string): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type MarketplaceAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type MarketplaceServiceContext = ServiceContext

export type MarketplaceServiceDeps = {
  apps: MarketplaceAppStore
  installations: AppInstallationStore
  grants: AppScopeGrantStore
  audit: AuditWriter<MarketplaceAuditInput>
  events?: EventEmitter
}
