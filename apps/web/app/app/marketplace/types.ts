import type { BadgeTone } from "@yourcrm/ui"

/**
 * Wire types for `/app/marketplace`.
 *
 * Mirrors the API DTOs in `@yourcrm/crm/src/marketplace/schemas.ts`. There
 * is no field anywhere here for app code, a bundle URL, or a secret this
 * app authenticates with — P0 has none of those (see
 * `packages/integrations/MARKETPLACE.md`, "Not built in P0").
 */

export type AppScope = {
  object: string
  action: string
}

export type AppWebhookDeclaration = {
  event: string
  description?: string | null
}

export type AppUiExtensionDeclaration = {
  location: string
  label: string
}

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

export type MarketplaceApp = {
  id: string
  appKey: string
  name: string
  version: string
  publisher: string
  description?: string | null
  status: string
  manifest: AppManifest
  createdAt?: string | null
}

export type AppInstallation = {
  id: string
  workspaceId: string
  appId: string
  appVersion: string
  status: string
  installedBy?: string | null
  installedAt?: string | null
  uninstalledAt?: string | null
}

export type AppScopeGrant = {
  id: string
  installationId: string
  object: string
  action: string
}

export type InstallationDetail = {
  installation: AppInstallation
  grants: AppScopeGrant[]
}

export type InstallResult = {
  installation: AppInstallation
  grantedScopes: AppScope[]
  deniedScopes: AppScope[]
}

export type MarketplaceAppListResponse = {
  data: MarketplaceApp[]
  pagination: { nextCursor: string | null; limit: number }
}

export type AppInstallationListResponse = {
  data: AppInstallation[]
  pagination: { nextCursor: string | null; limit: number }
}

/** `{ object: "person", action: "read" }` -> `"person · read"`. */
export function formatScope(scope: AppScope): string {
  return `${scope.object} · ${scope.action}`
}

/** `"person:read"` -> `{ object: "person", action: "read" }`. */
export function parseScopeString(scope: string): AppScope {
  const separatorIndex = scope.indexOf(":")
  return { object: scope.slice(0, separatorIndex), action: scope.slice(separatorIndex + 1) }
}

export function statusTone(status: string): BadgeTone {
  if (status === "active" || status === "published") return "success"
  if (status === "uninstalled" || status === "deprecated") return "secondary"
  return "outline"
}

export function statusLabel(status: string): string {
  if (status === "active") return "Installed"
  if (status === "uninstalled") return "Uninstalled"
  if (status === "published") return "Published"
  if (status === "draft") return "Draft"
  if (status === "deprecated") return "Deprecated"
  return status
}

/** Installations for a given app id, newest first. */
export function installationsForApp(
  installations: readonly AppInstallation[],
  appId: string,
): AppInstallation[] {
  return installations
    .filter((installation) => installation.appId === appId && installation.status === "active")
    .sort((a, b) => String(b.installedAt ?? "").localeCompare(String(a.installedAt ?? "")))
}
