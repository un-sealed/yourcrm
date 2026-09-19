import { createHash } from "node:crypto"
import { createEvent, getEventBus } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import { IntegrationEvents } from "./event-names"
import {
  connectIntegrationSchema,
  integrationConnectionQuerySchema,
  rotateIntegrationCredentialsSchema,
  updateIntegrationConnectionSchema,
} from "./schemas"
import type { IntegrationProviderSummaryDto } from "./schemas"
import { IntegrationSignatureError, requireIntegrationWebhookSignature } from "./webhook-signature"
import type {
  IntegrationConnectionListResult,
  IntegrationConnectionRecord,
  IntegrationCredentialMetadataRecord,
  IntegrationProviderPort,
  IntegrationsServiceContext,
  IntegrationsServiceDeps,
  IntegrationWebhookEventRecord,
} from "./types"

/* ------------------------------- errors ------------------------------- */

export class IntegrationConnectionNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`integration connection ${id} not found`)
    this.name = "IntegrationConnectionNotFoundError"
  }
}

export class IntegrationProviderNotRegisteredError extends Error {
  readonly code = "NOT_FOUND"
  constructor(providerId: string) {
    super(`integration provider "${providerId}" is not registered`)
    this.name = "IntegrationProviderNotRegisteredError"
  }
}

/**
 * P0 is API-key only. OAuth needs callback routing and a public URL this
 * deployment does not have — see the extension-point note in
 * `packages/integrations/src/provider.ts`.
 */
export class IntegrationOAuthNotSupportedError extends Error {
  readonly code = "NOT_IMPLEMENTED"
  constructor(providerId: string) {
    super(`provider "${providerId}" needs OAuth, which is not supported yet (API keys only)`)
    this.name = "IntegrationOAuthNotSupportedError"
  }
}

/** The provider rejected the credential or was unreachable. */
export class IntegrationConnectFailedError extends Error {
  readonly code = "INTEGRATION_CONNECT_FAILED"
  constructor(providerId: string, reason: string) {
    super(`provider "${providerId}" rejected the connection: ${reason}`)
    this.name = "IntegrationConnectFailedError"
  }
}

export class IntegrationWebhookNotSupportedError extends Error {
  readonly code = "WEBHOOK_NOT_SUPPORTED"
  constructor(providerId: string) {
    super(`provider "${providerId}" does not accept inbound webhooks`)
    this.name = "IntegrationWebhookNotSupportedError"
  }
}

export class IntegrationWebhookHandlerError extends Error {
  readonly code = "WEBHOOK_HANDLER_FAILED"
  constructor(reason: string) {
    super(`webhook handler failed: ${reason}`)
    this.name = "IntegrationWebhookHandlerError"
  }
}

/* ------------------------------ helpers ------------------------------- */

/**
 * Strip any secret that a careless provider echoed into an error message
 * before it reaches `last_error`, an audit row or a log line.
 */
export function redactIntegrationSecrets(
  message: string,
  ...secrets: (string | null | undefined)[]
): string {
  let output = message
  for (const secret of secrets) {
    if (secret && secret.length >= 8) output = output.split(secret).join("[redacted]")
  }
  return output.slice(0, 2000)
}

function reasonOf(err: unknown, ...secrets: (string | null | undefined)[]): string {
  const raw = err instanceof Error ? err.message : String(err)
  return redactIntegrationSecrets(raw, ...secrets)
}

function asConfigRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return { ...(value as Record<string, unknown>) }
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return body
  }
}

function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string | undefined,
): string | null {
  if (!name) return null
  return headers[name.toLowerCase()] ?? null
}

/** Deterministic fallback idempotency key for providers that send no id. */
function bodyFingerprint(rawBody: string): string {
  return `sha256:${createHash("sha256").update(rawBody, "utf8").digest("hex").slice(0, 48)}`
}

/* ------------------------------ contract ------------------------------ */

export type IntegrationConnectionDetail = {
  connection: IntegrationConnectionRecord
  /** Masked metadata only — this payload can never contain a secret. */
  credentials: IntegrationCredentialMetadataRecord[]
  webhookEvents: IntegrationWebhookEventRecord[]
  /** Path the provider should POST to. Public; carries no secret. */
  webhookPath: string | null
}

/** One verified inbound delivery, as returned to the webhook endpoint. */
export type IntegrationWebhookIngestRequest = {
  connectionId: string
  /** Lower-cased request headers. */
  headers: Readonly<Record<string, string>>
  /** EXACT request body bytes — the HMAC is computed over these. */
  rawBody: string
  correlationId?: string
}

export type IntegrationWebhookIngestResult = {
  status: "processed" | "ignored" | "duplicate"
  connectionId: string
  providerId: string
  providerEventId: string
  eventType: string | null
}

/** Public webhook path for a connection. Kept in one place. */
export function integrationWebhookPath(connectionId: string): string {
  return `/api/v1/integrations/${connectionId}/webhook`
}

/* ------------------------------ service ------------------------------- */

function permissionOf(ctx: IntegrationsServiceContext) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "integration",
    // Spec 31 §8: integrations are admin-only. Every method — including the
    // read paths — gates on `admin`, so a member cannot enumerate which
    // vendors a workspace is wired to.
    action: "admin" as const,
  }
}

/**
 * Integrations domain service (spec 31-integrations, P0).
 *
 * Every admin method:
 *  1. calls `requirePermission()` FIRST with the `admin` action;
 *  2. works through the injected stores and the provider catalogue;
 *  3. emits the domain event via `IntegrationEvents` (never a literal);
 *  4. writes an audit row with before/after (mutations only).
 *
 * `ingestWebhook()` is the ONE exception and takes no `ServiceContext` on
 * purpose: its caller is the provider, not a user, so there is no session to
 * gate. Its authentication is the constant-time HMAC check, which runs before
 * anything is read, written or dispatched — the same "authenticate first"
 * rule, enforced with the only credential a machine caller has. The public
 * form submission path (`forms/service.ts`) sets the same precedent.
 */
export function createIntegrationsService(deps: IntegrationsServiceDeps) {
  const events = deps.events ?? getEventBus()
  const now = deps.now ?? (() => new Date())

  function requireProvider(providerId: string): IntegrationProviderPort {
    const provider = deps.providers.get(providerId)
    if (!provider) throw new IntegrationProviderNotRegisteredError(providerId)
    return provider
  }

  async function loadConnection(
    ctx: IntegrationsServiceContext,
    id: string,
  ): Promise<IntegrationConnectionRecord> {
    const found = await deps.store.findById(ctx.workspaceId, id)
    if (!found) throw new IntegrationConnectionNotFoundError(id)
    return found
  }

  async function detailOf(
    workspaceId: string,
    connection: IntegrationConnectionRecord,
  ): Promise<IntegrationConnectionDetail> {
    const provider = deps.providers.get(connection.providerId)
    const [credentials, webhookEvents] = await Promise.all([
      deps.credentials.listMetadata(workspaceId, connection.id),
      deps.webhooks.list(workspaceId, connection.id, 25),
    ])
    return {
      connection,
      credentials,
      webhookEvents,
      webhookPath: provider?.webhook ? integrationWebhookPath(connection.id) : null,
    }
  }

  /** The catalogue: whatever is registered, never a hardcoded vendor list. */
  async function listProviders(
    ctx: IntegrationsServiceContext,
  ): Promise<IntegrationProviderSummaryDto[]> {
    requirePermission(permissionOf(ctx))
    const installed = await deps.store.list(ctx.workspaceId, { limit: 200 })
    const counts = new Map<string, number>()
    for (const connection of installed.data) {
      counts.set(connection.providerId, (counts.get(connection.providerId) ?? 0) + 1)
    }
    return deps.providers.list().map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      description: provider.description ?? null,
      category: provider.category,
      capabilities: [...provider.capabilities],
      authKind: provider.authKind,
      secretLabel: provider.secretLabel ?? null,
      docsUrl: provider.docsUrl ?? null,
      supportsWebhooks: provider.webhook !== undefined,
      connectionCount: counts.get(provider.id) ?? 0,
    }))
  }

  async function listConnections(
    ctx: IntegrationsServiceContext,
    rawQuery: unknown,
  ): Promise<IntegrationConnectionListResult> {
    requirePermission(permissionOf(ctx))
    const query = integrationConnectionQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function getConnection(
    ctx: IntegrationsServiceContext,
    id: string,
  ): Promise<IntegrationConnectionDetail> {
    requirePermission(permissionOf(ctx))
    return detailOf(ctx.workspaceId, await loadConnection(ctx, id))
  }

  /**
   * Install a provider for this workspace.
   *
   * The connection row is created first (status `disconnected`) so the
   * provider handshake has an id to bind credentials to; a rejected handshake
   * leaves a visible `error` connection the admin can rotate keys on, rather
   * than a silent failure.
   */
  async function connect(
    ctx: IntegrationsServiceContext,
    rawInput: unknown,
  ): Promise<IntegrationConnectionDetail> {
    requirePermission(permissionOf(ctx))
    const input = connectIntegrationSchema.parse(rawInput)
    const provider = requireProvider(input.providerId)
    if (provider.authKind !== "api_key") throw new IntegrationOAuthNotSupportedError(provider.id)
    const config = asConfigRecord(provider.configSchema.parse(input.config))

    const created = await deps.store.create(
      ctx.workspaceId,
      {
        providerId: provider.id,
        displayName: input.displayName,
        status: "disconnected",
        authKind: provider.authKind,
        config,
      },
      ctx.actorId,
    )

    let result
    try {
      result = await provider.connect({
        workspaceId: ctx.workspaceId,
        connectionId: created.id,
        displayName: input.displayName,
        config,
        secret: input.apiKey,
      })
    } catch (err) {
      const reason = reasonOf(err, input.apiKey, input.webhookSecret)
      const errored = await deps.store.update(
        ctx.workspaceId,
        created.id,
        { status: "error", lastError: reason, lastErrorAt: now() },
        ctx.actorId,
      )
      await events.emit(
        createEvent({
          event: IntegrationEvents.Errored,
          workspaceId: ctx.workspaceId,
          actorId: ctx.actorId,
          entityType: "integration_connection",
          entityId: created.id,
          after: errored ?? created,
          correlationId: ctx.correlationId,
        }),
      )
      await deps.audit({
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        action: "connect_failed",
        object: "integration_connection",
        recordId: created.id,
        after: { providerId: provider.id, status: "error", lastError: reason },
        correlationId: ctx.correlationId,
      })
      throw new IntegrationConnectFailedError(provider.id, reason)
    }

    await deps.credentials.put(
      ctx.workspaceId,
      {
        connectionId: created.id,
        kind: "api_key",
        secret: input.apiKey,
        scopes: result.scopes ?? input.scopes,
      },
      ctx.actorId,
    )
    if (input.webhookSecret !== undefined) {
      await deps.credentials.put(
        ctx.workspaceId,
        { connectionId: created.id, kind: "webhook_secret", secret: input.webhookSecret },
        ctx.actorId,
      )
    }

    const connected = await deps.store.update(
      ctx.workspaceId,
      created.id,
      {
        status: "connected",
        connectedAt: now(),
        disconnectedAt: null,
        lastError: null,
        lastErrorAt: null,
        externalAccountId: result.externalAccountId ?? null,
        ...(result.displayName ? { displayName: result.displayName } : {}),
        ...(result.config ? { config: asConfigRecord(result.config) } : {}),
      },
      ctx.actorId,
    )
    if (!connected) throw new IntegrationConnectionNotFoundError(created.id)

    await events.emit(
      createEvent({
        event: IntegrationEvents.Connected,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "integration_connection",
        entityId: connected.id,
        after: connected,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "connect",
      object: "integration_connection",
      recordId: connected.id,
      after: connected,
      correlationId: ctx.correlationId,
    })
    return detailOf(ctx.workspaceId, connected)
  }

  async function updateConnection(
    ctx: IntegrationsServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<IntegrationConnectionRecord> {
    requirePermission(permissionOf(ctx))
    const patch = updateIntegrationConnectionSchema.parse(rawPatch)
    const before = await loadConnection(ctx, id)
    const provider = requireProvider(before.providerId)
    const values: Record<string, unknown> = {}
    if (patch.displayName !== undefined) values.displayName = patch.displayName
    if (patch.config !== undefined) {
      values.config = asConfigRecord(provider.configSchema.parse(patch.config))
    }
    const after = await deps.store.update(ctx.workspaceId, id, values, ctx.actorId)
    if (!after) throw new IntegrationConnectionNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "integration_connection",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Rotate/reconnect: replace the API key, the webhook secret or both. A new
   * API key is re-verified through `provider.connect()` before it replaces
   * the old one, so a typo cannot leave the workspace disconnected silently.
   */
  async function rotateCredentials(
    ctx: IntegrationsServiceContext,
    id: string,
    rawInput: unknown,
  ): Promise<IntegrationConnectionDetail> {
    requirePermission(permissionOf(ctx))
    const input = rotateIntegrationCredentialsSchema.parse(rawInput)
    const before = await loadConnection(ctx, id)
    const provider = requireProvider(before.providerId)

    if (input.apiKey !== undefined) {
      try {
        await provider.connect({
          workspaceId: ctx.workspaceId,
          connectionId: before.id,
          displayName: before.displayName,
          config: asConfigRecord(before.config),
          secret: input.apiKey,
        })
      } catch (err) {
        throw new IntegrationConnectFailedError(
          provider.id,
          reasonOf(err, input.apiKey, input.webhookSecret),
        )
      }
      await deps.credentials.put(
        ctx.workspaceId,
        { connectionId: before.id, kind: "api_key", secret: input.apiKey },
        ctx.actorId,
      )
    }
    if (input.webhookSecret !== undefined) {
      await deps.credentials.put(
        ctx.workspaceId,
        { connectionId: before.id, kind: "webhook_secret", secret: input.webhookSecret },
        ctx.actorId,
      )
    }

    const after = await deps.store.update(
      ctx.workspaceId,
      before.id,
      { status: "connected", connectedAt: now(), lastError: null, lastErrorAt: null },
      ctx.actorId,
    )
    if (!after) throw new IntegrationConnectionNotFoundError(id)
    await events.emit(
      createEvent({
        event: IntegrationEvents.Reconnected,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "integration_connection",
        entityId: after.id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "rotate_credentials",
      object: "integration_connection",
      recordId: after.id,
      // Which slots were rotated — never the values.
      after: {
        rotated: [
          ...(input.apiKey === undefined ? [] : ["api_key"]),
          ...(input.webhookSecret === undefined ? [] : ["webhook_secret"]),
        ],
      },
      correlationId: ctx.correlationId,
    })
    return detailOf(ctx.workspaceId, after)
  }

  /**
   * Revoke: drop every stored credential, tell the provider if it is still
   * registered, and park the connection as `disconnected` so its history and
   * webhook event log survive.
   */
  async function disconnect(
    ctx: IntegrationsServiceContext,
    id: string,
  ): Promise<IntegrationConnectionRecord> {
    requirePermission(permissionOf(ctx))
    const before = await loadConnection(ctx, id)
    const provider = deps.providers.get(before.providerId)
    let note: string | null = null

    if (provider) {
      const secret = await deps.credentials.readSecret(ctx.workspaceId, before.id, "api_key")
      try {
        await provider.disconnect({
          workspaceId: ctx.workspaceId,
          connectionId: before.id,
          config: asConfigRecord(before.config),
          secret,
        })
      } catch (err) {
        // Best effort: a provider that cannot be reached must not block
        // revocation of the local credential.
        note = reasonOf(err, secret)
      }
    }

    await deps.credentials.deleteAll(ctx.workspaceId, before.id)
    const after = await deps.store.update(
      ctx.workspaceId,
      before.id,
      {
        status: "disconnected",
        disconnectedAt: now(),
        lastError: note,
        lastErrorAt: note === null ? null : now(),
      },
      ctx.actorId,
    )
    if (!after) throw new IntegrationConnectionNotFoundError(id)

    await events.emit(
      createEvent({
        event: IntegrationEvents.Disconnected,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "integration_connection",
        entityId: after.id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "disconnect",
      object: "integration_connection",
      recordId: after.id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /** Probe the provider and record the result on the connection. */
  async function checkHealth(
    ctx: IntegrationsServiceContext,
    id: string,
  ): Promise<IntegrationConnectionRecord> {
    requirePermission(permissionOf(ctx))
    const before = await loadConnection(ctx, id)
    const provider = requireProvider(before.providerId)
    const secret = await deps.credentials.readSecret(ctx.workspaceId, before.id, "api_key")

    let status: "connected" | "error" = "connected"
    let message: string | null = null
    try {
      const health = await provider.healthCheck({
        workspaceId: ctx.workspaceId,
        connectionId: before.id,
        config: asConfigRecord(before.config),
        secret,
      })
      status = health.status === "connected" ? "connected" : "error"
      message = health.message ? redactIntegrationSecrets(health.message, secret) : null
    } catch (err) {
      status = "error"
      message = reasonOf(err, secret)
    }

    const checkedAt = now()
    const after = await deps.store.update(
      ctx.workspaceId,
      before.id,
      {
        status,
        lastHealthCheckAt: checkedAt,
        lastHealthStatus: status,
        lastError: status === "error" ? message : null,
        lastErrorAt: status === "error" ? checkedAt : null,
      },
      ctx.actorId,
    )
    if (!after) throw new IntegrationConnectionNotFoundError(id)

    await events.emit(
      createEvent({
        event: status === "error" ? IntegrationEvents.Errored : IntegrationEvents.HealthChecked,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "integration_connection",
        entityId: after.id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "health_check",
      object: "integration_connection",
      recordId: after.id,
      after: { status, message },
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Inbound webhook ingestion — the unauthenticated ingress.
   *
   * Order is the security contract and must not be rearranged:
   *   1. resolve the connection (an unknown id fails as UNAUTHORIZED, not
   *      NOT_FOUND, so the endpoint is not a connection-id oracle);
   *   2. load the connection's `webhook_secret` and verify the HMAC in
   *      constant time — a missing secret fails the same way as a bad one;
   *   3. only then parse, deduplicate on the provider event id and dispatch.
   *
   * Deduplication is retry-aware: a delivery already `processed`/`ignored`/
   * `received` short-circuits, while a previously `failed` one is dispatched
   * again so provider retries can recover.
   */
  async function ingestWebhook(
    request: IntegrationWebhookIngestRequest,
  ): Promise<IntegrationWebhookIngestResult> {
    const connection = await deps.store.findForWebhook(request.connectionId)
    if (!connection) throw new IntegrationSignatureError()

    const provider = deps.providers.get(connection.providerId)
    if (!provider?.webhook) {
      throw new IntegrationWebhookNotSupportedError(connection.providerId)
    }
    const spec = provider.webhook

    const secret = await deps.credentials.readSecret(
      connection.workspaceId,
      connection.id,
      "webhook_secret",
    )
    if (!secret) throw new IntegrationSignatureError()

    requireIntegrationWebhookSignature({
      secret,
      rawBody: request.rawBody,
      algorithm: spec.algorithm,
      encoding: spec.encoding,
      prefix: spec.signaturePrefix,
      signature: headerValue(request.headers, spec.signatureHeader),
    })

    const payload = safeJsonParse(request.rawBody)
    const providerEventId =
      spec.extractEventId?.(payload, request.headers) ??
      headerValue(request.headers, spec.eventIdHeader) ??
      bodyFingerprint(request.rawBody)
    const eventType = spec.extractEventType?.(payload, request.headers) ?? null

    const existing = await deps.webhooks.find(connection.id, providerEventId)
    if (existing && existing.status !== "failed") {
      return {
        status: "duplicate",
        connectionId: connection.id,
        providerId: connection.providerId,
        providerEventId,
        eventType,
      }
    }

    const recorded =
      existing ??
      (await deps.webhooks.record(connection.workspaceId, {
        connectionId: connection.id,
        providerId: connection.providerId,
        providerEventId,
        eventType,
        payload,
      }))

    await events.emit(
      createEvent({
        event: IntegrationEvents.WebhookReceived,
        workspaceId: connection.workspaceId,
        actorType: "integration",
        entityType: "integration_webhook_event",
        entityId: recorded.id,
        after: { connectionId: connection.id, providerId: connection.providerId, eventType },
        correlationId: request.correlationId,
      }),
    )

    try {
      const outcome = await spec.handle({
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        providerId: connection.providerId,
        config: asConfigRecord(connection.config),
        providerEventId,
        eventType,
        headers: request.headers,
        rawBody: request.rawBody,
        payload,
      })
      await deps.webhooks.mark(connection.workspaceId, recorded.id, outcome.status, {
        eventType: outcome.eventType ?? eventType,
        error: null,
      })
      return {
        status: outcome.status,
        connectionId: connection.id,
        providerId: connection.providerId,
        providerEventId,
        eventType: outcome.eventType ?? eventType,
      }
    } catch (err) {
      // Error path only: also decrypt the API key so a handler that echoed it
      // into its message cannot write it to `error`, the audit row or a log.
      const apiKey = await deps.credentials
        .readSecret(connection.workspaceId, connection.id, "api_key")
        .catch(() => null)
      const reason = reasonOf(err, secret, apiKey)
      await deps.webhooks.mark(connection.workspaceId, recorded.id, "failed", { error: reason })
      await deps.audit({
        workspaceId: connection.workspaceId,
        actorId: null,
        action: "webhook_failed",
        object: "integration_webhook_event",
        recordId: recorded.id,
        after: { connectionId: connection.id, providerEventId, error: reason },
        correlationId: request.correlationId,
        source: "integration",
      })
      throw new IntegrationWebhookHandlerError(reason)
    }
  }

  return {
    listProviders,
    listConnections,
    getConnection,
    connect,
    updateConnection,
    rotateCredentials,
    disconnect,
    checkHealth,
    ingestWebhook,
  }
}

export type IntegrationsService = ReturnType<typeof createIntegrationsService>
