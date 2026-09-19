import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Integrations framework ports (spec 31-integrations, P0).
 *
 * ## The mirrored provider contract — read this first
 *
 * `IntegrationProviderPort` below is a STRUCTURAL MIRROR of
 * `IntegrationProvider` in `packages/integrations/src/provider.ts`. It is not
 * a second connector model: it is the same model, restated so this package
 * can reference it.
 *
 * Why: bun workspaces symlink only *declared* dependencies, and
 * `packages/crm/package.json` does not declare `@yourcrm/integrations`, so
 * `import ... from "@yourcrm/integrations"` does not resolve here (verified —
 * TS2307). Editing package.json is outside this agent's scope, so the gap is
 * reported as a blocker to the integrator. This is the same pattern
 * `../ports.ts` already uses for `WriteAuditInput`.
 *
 * When the dependency is wired, this whole block collapses to:
 *
 * ```ts
 * import type { IntegrationProvider } from "@yourcrm/integrations"
 * export type IntegrationProviderPort = IntegrationProvider
 * ```
 *
 * and nothing else in this module changes — the shapes are identical today.
 *
 * ## Everything else here is a store port
 *
 * `@yourcrm/crm` has no database dependency, so the service talks to the
 * structural stores below. `apps/api` adapts
 * `@yourcrm/database/src/repositories/integrations-repository` to them; tests
 * satisfy them with in-memory fakes.
 */

/* ------------------------------ provider ------------------------------ */

/** Mirror of `IntegrationConfigSchema`. Any zod schema satisfies it. */
export type IntegrationConfigSchemaPort = {
  parse(value: unknown): unknown
}

export type IntegrationConnectionStatusValue = "connected" | "disconnected" | "error"

export type IntegrationAuthKindValue = "api_key" | "oauth2"

export type IntegrationCredentialKindValue = "api_key" | "webhook_secret" | "oauth_tokens"

export type IntegrationProviderRuntimeContext = {
  workspaceId: string
  connectionId: string
  config: Record<string, unknown>
  /** Decrypted secret, in memory for this call only. Never log or persist. */
  secret: string | null
}

export type IntegrationConnectHookInput = IntegrationProviderRuntimeContext & {
  displayName: string
}

export type IntegrationConnectHookResult = {
  externalAccountId?: string | null
  displayName?: string | null
  scopes?: readonly string[]
  config?: Record<string, unknown>
}

export type IntegrationHealthHookResult = {
  status: IntegrationConnectionStatusValue
  message?: string | null
}

export type IntegrationWebhookDeliveryInput = {
  workspaceId: string
  connectionId: string
  providerId: string
  /** The connection's non-secret config — handlers need it for routing. */
  config: Record<string, unknown>
  providerEventId: string
  eventType: string | null
  headers: Readonly<Record<string, string>>
  rawBody: string
  payload: unknown
}

export type IntegrationWebhookHandlerResult = {
  status: "processed" | "ignored"
  eventType?: string | null
  detail?: string | null
}

export type IntegrationWebhookSpecPort = {
  signatureHeader: string
  algorithm: "sha1" | "sha256" | "sha512"
  encoding?: "hex" | "base64"
  signaturePrefix?: string
  eventIdHeader?: string
  extractEventId?: (payload: unknown, headers: Readonly<Record<string, string>>) => string | null
  extractEventType?: (payload: unknown, headers: Readonly<Record<string, string>>) => string | null
  handle: (delivery: IntegrationWebhookDeliveryInput) => Promise<IntegrationWebhookHandlerResult>
}

/** Structural mirror of `IntegrationProvider` — see the header. */
export type IntegrationProviderPort = {
  readonly id: string
  readonly displayName: string
  readonly description?: string
  readonly category: string
  readonly capabilities: readonly string[]
  readonly authKind: IntegrationAuthKindValue
  readonly configSchema: IntegrationConfigSchemaPort
  readonly secretLabel?: string
  readonly docsUrl?: string
  readonly webhook?: IntegrationWebhookSpecPort
  connect(input: IntegrationConnectHookInput): Promise<IntegrationConnectHookResult>
  disconnect(ctx: IntegrationProviderRuntimeContext): Promise<void>
  healthCheck(ctx: IntegrationProviderRuntimeContext): Promise<IntegrationHealthHookResult>
}

/**
 * Read side of the connector registry. `IntegrationProviderRegistry` from
 * `@yourcrm/integrations` satisfies this exactly, so the composition root
 * passes the registry straight in once the dependency is declared.
 */
export type IntegrationProviderCatalogPort = {
  get(providerId: string): IntegrationProviderPort | null
  list(): IntegrationProviderPort[]
}

/** Wrap a fixed provider list as a catalogue (tests, static wiring). */
export function createIntegrationProviderCatalog(
  providers: readonly IntegrationProviderPort[],
): IntegrationProviderCatalogPort {
  const byId = new Map(providers.map((provider) => [provider.id, provider]))
  return {
    get: (providerId) => byId.get(providerId) ?? null,
    list: () =>
      [...byId.values()].sort((a, b) =>
        a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" }),
      ),
  }
}

/* ------------------------------- stores ------------------------------- */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type IntegrationConnectionRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  providerId: string
  displayName: string
  status: string
}

/** Credential facts that are safe to serialise. Never carries a secret. */
export type IntegrationCredentialMetadataRecord = Record<string, unknown> & {
  id: string
  connectionId: string
  kind: string
  hint: string | null
}

export type IntegrationWebhookEventRecord = Record<string, unknown> & {
  id: string
  connectionId: string
  providerEventId: string
  status: string
}

export type IntegrationConnectionListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  providerId?: string
  status?: IntegrationConnectionStatusValue
}

export type IntegrationConnectionListResult = {
  data: IntegrationConnectionRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type IntegrationConnectionStore = {
  list(
    workspaceId: string,
    query: IntegrationConnectionListQuery,
  ): Promise<IntegrationConnectionListResult>
  findById(workspaceId: string, id: string): Promise<IntegrationConnectionRecord | null>
  /**
   * Resolve a connection with no session in hand — the inbound webhook path.
   * The workspace on the returned row scopes everything downstream.
   */
  findForWebhook(connectionId: string): Promise<IntegrationConnectionRecord | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<IntegrationConnectionRecord>
  update(
    workspaceId: string,
    id: string,
    patch: Record<string, unknown>,
    actorId?: string,
  ): Promise<IntegrationConnectionRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
}

export type IntegrationCredentialStore = {
  /** Seals `secret` at rest. Returns metadata only. */
  put(
    workspaceId: string,
    input: {
      connectionId: string
      kind: IntegrationCredentialKindValue
      secret: string
      scopes?: readonly string[]
      expiresAt?: Date | null
    },
    actorId?: string,
  ): Promise<IntegrationCredentialMetadataRecord>
  listMetadata(
    workspaceId: string,
    connectionId: string,
  ): Promise<IntegrationCredentialMetadataRecord[]>
  /** The only path to plaintext. Hand it to a provider hook, nowhere else. */
  readSecret(
    workspaceId: string,
    connectionId: string,
    kind: IntegrationCredentialKindValue,
  ): Promise<string | null>
  delete(
    workspaceId: string,
    connectionId: string,
    kind: IntegrationCredentialKindValue,
  ): Promise<void>
  deleteAll(workspaceId: string, connectionId: string): Promise<void>
}

export type IntegrationWebhookStore = {
  /** Idempotency probe on the provider event id. */
  find(connectionId: string, providerEventId: string): Promise<IntegrationWebhookEventRecord | null>
  record(
    workspaceId: string,
    input: {
      connectionId: string
      providerId: string
      providerEventId: string
      eventType?: string | null
      payload?: unknown
    },
  ): Promise<IntegrationWebhookEventRecord>
  mark(
    workspaceId: string,
    id: string,
    status: "received" | "processed" | "ignored" | "failed",
    patch?: { eventType?: string | null; error?: string | null },
  ): Promise<void>
  list(
    workspaceId: string,
    connectionId: string,
    limit?: number,
  ): Promise<IntegrationWebhookEventRecord[]>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type IntegrationAuditInput = {
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

export type IntegrationsServiceContext = ServiceContext

export type IntegrationsServiceDeps = {
  store: IntegrationConnectionStore
  credentials: IntegrationCredentialStore
  webhooks: IntegrationWebhookStore
  providers: IntegrationProviderCatalogPort
  audit: AuditWriter<IntegrationAuditInput>
  events?: EventEmitter
  /** Injectable clock — hermetic tests assert exact timestamps. */
  now?: () => Date
}
