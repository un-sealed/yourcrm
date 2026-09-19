import type { BadgeTone } from "@yourcrm/ui"

/**
 * Wire types for `/app/integrations`.
 *
 * Mirrors the API DTOs in `@yourcrm/crm/src/integrations/schemas.ts`. Note
 * what is NOT here: there is no field anywhere in this file that can hold a
 * credential. The API returns a masked `hint` and nothing else, and the UI
 * has no way to read a secret back — connect and rotate are write-only.
 */

export type IntegrationConnectionStatus = "connected" | "disconnected" | "error"

export type IntegrationProviderSummary = {
  id: string
  displayName: string
  description?: string | null
  category: string
  capabilities: string[]
  authKind: string
  secretLabel?: string | null
  docsUrl?: string | null
  supportsWebhooks: boolean
  connectionCount: number
}

export type IntegrationConnection = {
  id: string
  workspaceId: string
  providerId: string
  displayName: string
  status: string
  authKind: string
  externalAccountId?: string | null
  lastHealthCheckAt?: string | null
  lastHealthStatus?: string | null
  lastError?: string | null
  connectedAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export type IntegrationCredentialMetadata = {
  id: string
  connectionId: string
  kind: string
  /** Masked display value, e.g. `sk-…4f2a`. Never the secret itself. */
  hint: string | null
  scopes: string[]
}

export type IntegrationWebhookEvent = {
  id: string
  providerEventId: string
  eventType?: string | null
  status: string
  error?: string | null
  receivedAt?: string | null
}

export type IntegrationConnectionDetail = {
  connection: IntegrationConnection
  credentials: IntegrationCredentialMetadata[]
  webhookEvents: IntegrationWebhookEvent[]
  webhookPath: string | null
}

export type IntegrationConnectionListResponse = {
  data: IntegrationConnection[]
  pagination: { nextCursor: string | null; limit: number }
}

/** Status -> badge tone. Never color alone: the label carries the meaning. */
export function statusTone(status: string): BadgeTone {
  if (status === "connected") return "success"
  if (status === "error") return "destructive"
  return "secondary"
}

export function statusLabel(status: string): string {
  if (status === "connected") return "Connected"
  if (status === "error") return "Error"
  if (status === "disconnected") return "Disconnected"
  return status
}

/** Human-readable capability, e.g. `email.send` -> "email · send". */
export function capabilityLabel(capability: string): string {
  return capability.split(".").join(" · ")
}

/** Connections for a provider, newest first. */
export function connectionsForProvider(
  connections: readonly IntegrationConnection[],
  providerId: string,
): IntegrationConnection[] {
  return connections
    .filter((connection) => connection.providerId === providerId)
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
}

/** Group the catalogue by category for the page's section headings. */
export function groupProvidersByCategory(
  providers: readonly IntegrationProviderSummary[],
): { category: string; providers: IntegrationProviderSummary[] }[] {
  const groups = new Map<string, IntegrationProviderSummary[]>()
  for (const provider of providers) {
    const bucket = groups.get(provider.category) ?? []
    bucket.push(provider)
    groups.set(provider.category, bucket)
  }
  return [...groups.entries()]
    .map(([category, list]) => ({
      category,
      providers: [...list].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category))
}
