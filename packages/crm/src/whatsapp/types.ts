import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * WhatsApp service ports (spec 16-whatsapp, P0), following the `people`
 * reference pattern: `@yourcrm/crm` has no database dependency, so the
 * service talks to these structural stores. `apps/api` adapts the drizzle
 * `whatsapp-repository.ts` to them; hermetic tests satisfy them with fakes.
 */

/* ------------------------------- records ------------------------------- */

export type WhatsAppConversationRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  connectionId: string
  contactPhone: string
  status: string
  lastInboundAt: unknown
  lastOutboundAt: unknown
}

export type WhatsAppMessageRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  conversationId: string
  direction: string
  kind: string
  status: string
  providerMessageId: string | null
}

export type WhatsAppTemplateRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  connectionId: string
  name: string
  status: string
  bodyText: string
}

/* -------------------------------- stores -------------------------------- */

export type WhatsAppConversationListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  status?: string
  personId?: string
  companyId?: string
  connectionId?: string
}

export type WhatsAppListResult<T> = {
  data: T[]
  pagination: { nextCursor: string | null; limit: number }
}

export type WhatsAppConversationStore = {
  list(
    workspaceId: string,
    query: WhatsAppConversationListQuery,
  ): Promise<WhatsAppListResult<WhatsAppConversationRecord>>
  findById(workspaceId: string, id: string): Promise<WhatsAppConversationRecord | null>
  /** Idempotent open-or-create, keyed on (connection, E.164 contact phone). */
  findOrCreate(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<{ record: WhatsAppConversationRecord; created: boolean }>
  update(
    workspaceId: string,
    id: string,
    patch: Record<string, unknown>,
    actorId?: string,
  ): Promise<WhatsAppConversationRecord | null>
  /** Opens/refreshes the 24h session window. */
  touchInbound(
    workspaceId: string,
    conversationId: string,
    occurredAt: Date,
    preview: string | null,
  ): Promise<void>
  touchOutbound(
    workspaceId: string,
    conversationId: string,
    occurredAt: Date,
    preview: string | null,
  ): Promise<void>
  markRead(workspaceId: string, conversationId: string): Promise<void>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
}

export type WhatsAppMessageStore = {
  list(
    workspaceId: string,
    conversationId: string,
    opts: { limit?: number; cursor?: string; order?: "asc" | "desc" },
  ): Promise<WhatsAppListResult<WhatsAppMessageRecord>>
  findById(workspaceId: string, id: string): Promise<WhatsAppMessageRecord | null>
  findByProviderMessageId(
    workspaceId: string,
    providerMessageId: string,
  ): Promise<WhatsAppMessageRecord | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<WhatsAppMessageRecord>
  update(
    workspaceId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<WhatsAppMessageRecord | null>
  /** Idempotent on `providerMessageId` — safe for a replayed webhook delivery. */
  recordInbound(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<{ record: WhatsAppMessageRecord; created: boolean }>
  /**
   * Applies a status transition only if it advances the message's rank —
   * out-of-order-safe. `applied: false` means a duplicate or a regression
   * was ignored; the row returned is always the message's current state.
   */
  applyStatus(
    workspaceId: string,
    providerMessageId: string,
    status: string,
    patch?: { error?: string | null; occurredAt?: Date },
  ): Promise<{ record: WhatsAppMessageRecord; applied: boolean } | null>
}

export type WhatsAppTemplateStore = {
  list(
    workspaceId: string,
    opts: { connectionId?: string; limit?: number; cursor?: string },
  ): Promise<WhatsAppListResult<WhatsAppTemplateRecord>>
  findById(workspaceId: string, id: string): Promise<WhatsAppTemplateRecord | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<WhatsAppTemplateRecord>
}

/* ----------------------------- integrations ----------------------------- */

/**
 * Read-only view of the workspace's WhatsApp `integration_connections` row,
 * resolved through the integrations module's own repository (this module
 * never queries that table directly — see `../integrations`).
 */
export type WhatsAppConnectionRecord = {
  id: string
  workspaceId: string
  providerId: string
  status: string
  config: Record<string, unknown>
}

export type WhatsAppConnectionPort = {
  findById(workspaceId: string, connectionId: string): Promise<WhatsAppConnectionRecord | null>
  /** The provider API key. Never logged, persisted or returned. */
  readSecret(workspaceId: string, connectionId: string): Promise<string | null>
}

/* ------------------------------- provider -------------------------------
 *
 * `IntegrationProviderPort` (connect/disconnect/healthCheck/webhook) is the
 * generic connector-lifecycle contract every module reuses — see
 * `../integrations`. It has no "send a message" hook, because that shape is
 * different for every capability (email.send, messaging.send, calling.place,
 * …), so this module defines its own narrow adapter for the messaging
 * capability. A concrete provider (e.g. the console/dev provider) implements
 * BOTH `IntegrationProviderPort` and `WhatsAppProviderAdapter`.
 * ------------------------------------------------------------------------ */

export type WhatsAppSendTextInput = {
  workspaceId: string
  connectionId: string
  config: Record<string, unknown>
  /** Decrypted API key, in memory for this call only. */
  secret: string
  /** E.164. */
  to: string
  body: string
}

export type WhatsAppSendTemplateInput = {
  workspaceId: string
  connectionId: string
  config: Record<string, unknown>
  secret: string
  to: string
  templateName: string
  language: string
  variables: readonly string[]
}

export type WhatsAppSendResult = {
  /** Provider-assigned message id (Meta `wamid…`). Stored as the idempotency key. */
  providerMessageId: string
}

export type WhatsAppProviderAdapter = {
  sendText(input: WhatsAppSendTextInput): Promise<WhatsAppSendResult>
  sendTemplate(input: WhatsAppSendTemplateInput): Promise<WhatsAppSendResult>
}

/* --------------------------------- misc ---------------------------------- */

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type WhatsAppAuditInput = {
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

export type WhatsAppServiceContext = ServiceContext

export type WhatsAppServiceDeps = {
  conversations: WhatsAppConversationStore
  messages: WhatsAppMessageStore
  templates: WhatsAppTemplateStore
  connections: WhatsAppConnectionPort
  provider: WhatsAppProviderAdapter
  audit: AuditWriter<WhatsAppAuditInput>
  events?: EventEmitter
  /** Injectable clock — hermetic tests assert exact session-window boundaries. */
  now?: () => Date
}

/* ------------------------------- inbound --------------------------------
 * Shape the provider's webhook `handle()` hands to the service. No
 * `ServiceContext` here on purpose: the caller is the provider (the
 * framework already verified the HMAC), not a user — see
 * `ingestInboundMessage`/`ingestStatusUpdate` in `service.ts`, which mirror
 * `IntegrationsService.ingestWebhook`'s "no permission gate, the signature
 * check IS the authentication" rule.
 * ------------------------------------------------------------------------ */

export type WhatsAppInboundMedia = {
  kind: string
  storageKey?: string | null
  contentType?: string | null
  fileName?: string | null
  sizeBytes?: number | null
}

export type WhatsAppInboundMessageInput = {
  workspaceId: string
  connectionId: string
  from: string
  providerMessageId: string
  text?: string | null
  media?: WhatsAppInboundMedia | null
  occurredAt: Date
  correlationId?: string
}

export type WhatsAppInboundStatusInput = {
  workspaceId: string
  providerMessageId: string
  status: string
  error?: string | null
  occurredAt: Date
  correlationId?: string
}
