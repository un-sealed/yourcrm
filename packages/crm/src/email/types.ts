import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"
import type { EmailThreadLookupPort } from "./threading"

/**
 * Email module ports (spec 14-email, P0).
 *
 * `@yourcrm/crm` has no database dependency, so the service talks to the
 * structural stores below; `apps/api/src/routes/modules/email.ts` adapts
 * `packages/database/src/repositories/email-repository.ts` to them and the
 * hermetic tests satisfy them with in-memory fakes. Same pattern as the
 * `people` reference module.
 *
 * HOW THIS MODULE REACHES A PROVIDER
 * ----------------------------------
 * It does not import the integrations service, and it never reads a
 * credential itself. Three narrow ports keep the secret path exactly one
 * hop long:
 *
 *   EmailConnectionStore  -> which connection do we send through?
 *   EmailSecretReader     -> the decrypted API key, for the duration of one
 *                            `sendEmail()` call (backed by
 *                            `readCredentialSecret()` in the composition
 *                            root; the value is never persisted, logged or
 *                            returned)
 *   EmailTransportCatalog -> the provider adapter that actually sends
 *
 * The console provider (`console-email-provider.ts`) implements both
 * `IntegrationProviderPort` (lifecycle + inbound webhook) and
 * `EmailTransportPort` (outbound), so one registered object covers the whole
 * round trip with no real credentials.
 */

/* ------------------------------- records ------------------------------ */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type EmailThreadRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type EmailMessageRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  threadId: string
}

export type EmailParticipantRecord = Record<string, unknown> & {
  id: string
  role: string
  address: string
}

export type EmailAttachmentRecord = Record<string, unknown> & {
  id: string
  fileName: string
}

export type EmailMessageDetail = {
  message: EmailMessageRecord
  participants: EmailParticipantRecord[]
  attachments: EmailAttachmentRecord[]
}

export type EmailThreadDetail = {
  thread: EmailThreadRecord
  messages: EmailMessageDetail[]
}

export type EmailThreadListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
  personId?: string
  companyId?: string
  dealId?: string
}

export type EmailThreadListResult = {
  data: EmailThreadRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

/* -------------------------------- stores ------------------------------ */

/**
 * Thread persistence. Extends `EmailThreadLookupPort` so the threading
 * resolver can be handed the store directly.
 */
export type EmailThreadStore = EmailThreadLookupPort & {
  list(workspaceId: string, query: EmailThreadListQuery): Promise<EmailThreadListResult>
  findById(workspaceId: string, id: string): Promise<EmailThreadRecord | null>
  findWithMessages(workspaceId: string, id: string): Promise<EmailThreadDetail | null>
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<EmailThreadRecord>
  update(
    workspaceId: string,
    id: string,
    patch: Record<string, unknown>,
    actorId?: string,
  ): Promise<EmailThreadRecord | null>
  /** Recompute message_count and roll last_message_at forward. */
  refreshCounters(
    workspaceId: string,
    threadId: string,
    lastMessageAt: Date,
  ): Promise<EmailThreadRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
}

export type EmailMessageStore = {
  create(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<EmailMessageDetail>
  update(
    workspaceId: string,
    id: string,
    patch: Record<string, unknown>,
    actorId?: string,
  ): Promise<EmailMessageRecord | null>
  findById(workspaceId: string, id: string): Promise<EmailMessageRecord | null>
  /** Idempotency probe for webhook re-delivery, on the normalised Message-ID. */
  findByMessageId(workspaceId: string, messageId: string): Promise<EmailMessageRecord | null>
  findWithDetail(workspaceId: string, id: string): Promise<EmailMessageDetail | null>
}

/* ------------------------------ transport ----------------------------- */

/** The email connection a send goes out on. Carries no secret. */
export type EmailOutboundConnectionRecord = {
  id: string
  providerId: string
  /** Non-secret provider settings (from address, reply-to domain, …). */
  config: Record<string, unknown>
}

export type EmailConnectionStore = {
  /**
   * The email-capable connection to send through. With a `connectionId` it
   * resolves that one (and only when it belongs to the workspace); without,
   * the workspace's default connected email integration.
   */
  findSendable(
    workspaceId: string,
    connectionId?: string | null,
  ): Promise<EmailOutboundConnectionRecord | null>
}

export type EmailSecretReader = {
  /**
   * Decrypted provider API key, in memory for one call only. Backed by
   * `readCredentialSecret()`. Never persist, log or return the value.
   */
  readApiKey(workspaceId: string, connectionId: string): Promise<string | null>
}

export type EmailTransportAddress = {
  address: string
  name?: string | null
}

/** What the adapter is asked to put on the wire. */
export type EmailTransportSendInput = {
  /** Our RFC 5322 Message-ID for this send, already normalised. */
  messageId: string
  inReplyTo: string | null
  referenceIds: string[]
  subject: string
  from: EmailTransportAddress
  to: EmailTransportAddress[]
  cc: EmailTransportAddress[]
  bcc: EmailTransportAddress[]
  replyTo: EmailTransportAddress | null
  bodyText: string
  bodyHtml: string | null
}

/**
 * Runtime handle for one send. Mirrors `IntegrationProviderRuntimeContext`:
 * `secret` is live for this call only.
 */
export type EmailTransportContext = {
  workspaceId: string
  connectionId: string
  config: Record<string, unknown>
  secret: string | null
}

export type EmailTransportSendResult = {
  /** Provider-side id, recorded on the message. Null when not issued yet. */
  providerMessageId?: string | null
  /** `queued` when the provider accepted it for later delivery. */
  status?: "sent" | "queued"
  sentAt?: Date | null
}

/** Outbound half of an email provider adapter. */
export type EmailTransportPort = {
  readonly id: string
  sendEmail(
    input: EmailTransportSendInput,
    ctx: EmailTransportContext,
  ): Promise<EmailTransportSendResult>
}

/** Read side of the transport registry, keyed by provider id. */
export type EmailTransportCatalogPort = {
  get(providerId: string): EmailTransportPort | null
}

/** Wrap a fixed adapter list as a catalogue (tests, static wiring). */
export function createEmailTransportCatalog(
  transports: readonly EmailTransportPort[],
): EmailTransportCatalogPort {
  const byId = new Map(transports.map((transport) => [transport.id, transport]))
  return { get: (providerId) => byId.get(providerId) ?? null }
}

/* -------------------------------- service ----------------------------- */

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type EmailAuditInput = {
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

export type EmailServiceContext = ServiceContext

export type EmailServiceDeps = {
  threads: EmailThreadStore
  messages: EmailMessageStore
  connections: EmailConnectionStore
  secrets: EmailSecretReader
  transports: EmailTransportCatalogPort
  audit: AuditWriter<EmailAuditInput>
  events?: EventEmitter
  /** Injectable clock — hermetic tests assert exact timestamps. */
  now?: () => Date
  /**
   * How far back the subject+participant fallback may reach, in days. 0
   * disables the bound. Default 30: long enough for a slow reply thread,
   * short enough that a recurring subject ("Invoice") does not accrete.
   */
  subjectFallbackWindowDays?: number
  /**
   * RFC 5322 Message-ID minted for outbound sends. Injectable so tests are
   * deterministic; the default is `<uuid>@<sender domain>`.
   */
  newMessageId?: (input: { workspaceId: string; fromAddress: string }) => string
}
