import { randomUUID } from "node:crypto"
import { CommunicationEvents, createEvent, getEventBus } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import { redactIntegrationSecrets } from "../integrations"
import { emailDisplayText, emailSnippetOf, sanitizeEmailHtml } from "./sanitize"
import {
  emailThreadQuerySchema,
  inboundEmailMessageSchema,
  sendEmailMessageSchema,
  updateEmailThreadSchema,
} from "./schemas"
import type { EmailAddressInput } from "./schemas"
import { normalizeEmailAddress, normalizeEmailMessageId, resolveEmailThread } from "./threading"
import type {
  EmailMessageDetail,
  EmailMessageRecord,
  EmailServiceContext,
  EmailServiceDeps,
  EmailThreadDetail,
  EmailThreadListResult,
  EmailThreadRecord,
  EmailTransportAddress,
} from "./types"

/* ------------------------------- errors ------------------------------- */

export class EmailThreadNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`email thread ${id} not found`)
    this.name = "EmailThreadNotFoundError"
  }
}

export class EmailMessageNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`email message ${id} not found`)
    this.name = "EmailMessageNotFoundError"
  }
}

/** No connected email integration to send through. */
export class EmailConnectionUnavailableError extends Error {
  readonly code = "EMAIL_CONNECTION_UNAVAILABLE"
  constructor() {
    super("no connected email integration is available for this workspace")
    this.name = "EmailConnectionUnavailableError"
  }
}

/** The connection's provider has no registered outbound adapter. */
export class EmailTransportUnavailableError extends Error {
  readonly code = "EMAIL_CONNECTION_UNAVAILABLE"
  constructor(providerId: string) {
    super(`provider "${providerId}" cannot send email in this deployment`)
    this.name = "EmailTransportUnavailableError"
  }
}

export class EmailSenderAddressMissingError extends Error {
  readonly code = "VALIDATION_ERROR"
  constructor() {
    super("no from address: pass `from` or configure one on the connection")
    this.name = "EmailSenderAddressMissingError"
  }
}

/** The provider rejected the send. `message` is already redacted. */
export class EmailSendFailedError extends Error {
  readonly code = "EMAIL_SEND_FAILED"
  constructor(providerId: string, reason: string) {
    super(`provider "${providerId}" rejected the message: ${reason}`)
    this.name = "EmailSendFailedError"
  }
}

/* ------------------------------ helpers ------------------------------- */

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function readStringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function toTransportAddress(input: EmailAddressInput): EmailTransportAddress {
  return { address: input.address, name: input.name ?? null }
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@")
  const domain = at === -1 ? "" : address.slice(at + 1).trim()
  return domain.length === 0 ? "yourcrm.local" : domain
}

function reasonOf(err: unknown, secret: string | null): string {
  const raw = err instanceof Error ? err.message : String(err)
  return redactIntegrationSecrets(raw, secret)
}

/**
 * Event/audit payload for a message. Deliberately omits every body and
 * recipient list: spec 14 §17 says message content must not be logged
 * unnecessarily, and an event envelope is a log.
 */
function emailMessageSummary(message: EmailMessageRecord): Record<string, unknown> {
  return {
    id: message.id,
    threadId: message.threadId,
    direction: message.direction,
    status: message.status,
    subject: message.subject,
    messageId: message.messageId,
    providerId: message.providerId,
    providerMessageId: message.providerMessageId,
  }
}

function permissionOf(
  ctx: EmailServiceContext,
  object: "email_thread" | "email_message",
  action: "read" | "create" | "update" | "delete" | "send_external",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object,
    action,
  }
}

/* ------------------------------ contract ------------------------------ */

export type EmailInboundResult = {
  status: "created" | "duplicate"
  threadId: string
  messageId: string
  /** How the thread was chosen — useful in webhook logs. */
  threadReason: "reference" | "subject" | "new" | "existing"
}

/* ------------------------------ service ------------------------------- */

/**
 * Email domain service (spec 14-email, P0) — mirrors the `people` reference.
 *
 * Every session method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. works through the injected stores (never a repository or SQL);
 *  3. emits the domain event via the `CommunicationEvents` constant;
 *  4. writes an audit row (mutations only).
 *
 * `receiveInboundEmail()` is the ONE exception and takes no `ServiceContext`
 * on purpose: its caller is a provider webhook, not a user, so there is no
 * session to gate. Its authentication happened upstream — the integrations
 * framework verified the HMAC in constant time before dispatching to the
 * provider's `handle()`. Same precedent as
 * `integrations/service.ts#ingestWebhook` and the public form-submission
 * path. It is idempotent on the normalised RFC 5322 Message-ID so a retried
 * delivery appends nothing.
 *
 * SECRETS: the service never reads a credential store. It asks
 * `deps.secrets.readApiKey()` for one value, hands it straight to the
 * transport, and pushes every provider error through
 * `redactIntegrationSecrets()` before it reaches `last_error`, an audit row
 * or an exception message.
 */
export function createEmailService(deps: EmailServiceDeps) {
  const events = deps.events ?? getEventBus()
  const now = deps.now ?? (() => new Date())
  const windowDays = deps.subjectFallbackWindowDays ?? 30

  /** Cutoff for the subject fallback; null when the window is disabled. */
  function activeSince(): Date | null {
    if (windowDays <= 0) return null
    return new Date(now().getTime() - windowDays * 24 * 60 * 60 * 1000)
  }

  function mintMessageId(workspaceId: string, fromAddress: string): string {
    const raw =
      deps.newMessageId?.({ workspaceId, fromAddress }) ??
      `${randomUUID()}@${domainOf(fromAddress)}`
    return normalizeEmailMessageId(raw) ?? `${randomUUID()}@yourcrm.local`
  }

  /**
   * Place a message in a thread, creating one when nothing matches. Returns
   * the thread id and how it was chosen. The keys frozen onto a new thread
   * come from the resolver — see `threading.ts`.
   */
  async function placeInThread(
    workspaceId: string,
    input: {
      subject: string | null
      inReplyTo: string | null
      referenceIds: string[]
      addresses: (string | null)[]
      links: { personId?: string | null; companyId?: string | null; dealId?: string | null }
      ownerId?: string | null
      actorId?: string
      occurredAt: Date
    },
  ): Promise<{ threadId: string; reason: "reference" | "subject" | "new" }> {
    const resolution = await resolveEmailThread(deps.threads, {
      workspaceId,
      subject: input.subject,
      inReplyTo: input.inReplyTo,
      references: input.referenceIds,
      addresses: input.addresses,
      activeSince: activeSince(),
    })
    if (resolution.threadId !== null) {
      return { threadId: resolution.threadId, reason: resolution.reason }
    }
    const thread = await deps.threads.create(
      workspaceId,
      {
        subject: input.subject,
        normalizedSubject: resolution.normalizedSubject,
        participantKey: resolution.participantKey,
        status: "open",
        lastMessageAt: input.occurredAt,
        ownerId: input.ownerId ?? null,
        personId: input.links.personId ?? null,
        companyId: input.links.companyId ?? null,
        dealId: input.links.dealId ?? null,
      },
      input.actorId,
    )
    return { threadId: thread.id, reason: "new" }
  }

  /* ------------------------------ reads ------------------------------ */

  async function listThreads(
    ctx: EmailServiceContext,
    rawQuery: unknown,
  ): Promise<EmailThreadListResult> {
    requirePermission(permissionOf(ctx, "email_thread", "read"))
    const query = emailThreadQuerySchema.parse(rawQuery)
    return deps.threads.list(ctx.workspaceId, query)
  }

  async function getThread(ctx: EmailServiceContext, id: string): Promise<EmailThreadDetail> {
    requirePermission(permissionOf(ctx, "email_thread", "read"))
    const found = await deps.threads.findWithMessages(ctx.workspaceId, id)
    if (!found) throw new EmailThreadNotFoundError(id)
    return found
  }

  async function getMessage(ctx: EmailServiceContext, id: string): Promise<EmailMessageDetail> {
    requirePermission(permissionOf(ctx, "email_message", "read"))
    const found = await deps.messages.findWithDetail(ctx.workspaceId, id)
    if (!found) throw new EmailMessageNotFoundError(id)
    return found
  }

  /* ------------------------------ writes ----------------------------- */

  /**
   * Link a thread to CRM records, rename it or archive it. `personId`,
   * `companyId` and `dealId` are plain uuids — this module does not own
   * those tables and never joins across them.
   */
  async function updateThread(
    ctx: EmailServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<EmailThreadRecord> {
    requirePermission(permissionOf(ctx, "email_thread", "update"))
    const patch = updateEmailThreadSchema.parse(rawPatch)
    const before = await deps.threads.findById(ctx.workspaceId, id)
    if (!before) throw new EmailThreadNotFoundError(id)
    const after = await deps.threads.update(ctx.workspaceId, id, { ...patch }, ctx.actorId)
    if (!after) throw new EmailThreadNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "email_thread",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Compose, persist, send, record the outcome.
   *
   * The row is written BEFORE the provider call (status `queued`) so a send
   * that fails half-way is visible and retryable instead of vanishing — the
   * same "create first, then handshake" shape `integrations.connect()` uses.
   */
  async function sendMessage(
    ctx: EmailServiceContext,
    rawInput: unknown,
  ): Promise<EmailMessageDetail> {
    // `send_external` (spec 05): viewers may read a thread but may never put
    // a message on the wire in the workspace's name.
    requirePermission(permissionOf(ctx, "email_message", "send_external"))
    const input = sendEmailMessageSchema.parse(rawInput)

    const connection = await deps.connections.findSendable(
      ctx.workspaceId,
      input.connectionId ?? null,
    )
    if (!connection) throw new EmailConnectionUnavailableError()
    const transport = deps.transports.get(connection.providerId)
    if (!transport) throw new EmailTransportUnavailableError(connection.providerId)

    const configuredFrom = normalizeEmailAddress(
      typeof connection.config.fromAddress === "string" ? connection.config.fromAddress : null,
    )
    const fromAddress = input.from?.address ?? configuredFrom
    if (fromAddress === null || fromAddress === undefined)
      throw new EmailSenderAddressMissingError()
    const fromName =
      input.from?.name ??
      (typeof connection.config.fromName === "string" ? connection.config.fromName : null)

    // Reply headers come from the stored parent, never from the client: a
    // caller cannot splice a message into a thread it cannot see.
    let parent: EmailMessageRecord | null = null
    if (input.replyToMessageId) {
      parent = await deps.messages.findById(ctx.workspaceId, input.replyToMessageId)
      if (!parent) throw new EmailMessageNotFoundError(input.replyToMessageId)
    }
    const inReplyTo = parent ? normalizeEmailMessageId(readStringField(parent, "messageId")) : null
    const referenceIds = parent
      ? [...readStringArrayField(parent, "referenceIds"), ...(inReplyTo ? [inReplyTo] : [])]
      : []

    const occurredAt = now()
    const messageId = mintMessageId(ctx.workspaceId, fromAddress)
    const recipients = [...input.to, ...input.cc, ...input.bcc]
    const addresses = [fromAddress, ...recipients.map((r) => r.address)]

    let threadId: string
    if (input.threadId) {
      const thread = await deps.threads.findById(ctx.workspaceId, input.threadId)
      if (!thread) throw new EmailThreadNotFoundError(input.threadId)
      threadId = thread.id
    } else {
      const placed = await placeInThread(ctx.workspaceId, {
        subject: input.subject,
        inReplyTo,
        referenceIds,
        addresses,
        links: input,
        ownerId: ctx.actorId,
        actorId: ctx.actorId,
        occurredAt,
      })
      threadId = placed.threadId
    }

    const bodyText = emailDisplayText(input.bodyText, input.bodyHtml)
    const bodyHtml = sanitizeEmailHtml(input.bodyHtml)
    const participants = [
      { role: "from", address: fromAddress, displayName: fromName ?? null },
      ...input.to.map((r) => ({ role: "to", address: r.address, displayName: r.name ?? null })),
      ...input.cc.map((r) => ({ role: "cc", address: r.address, displayName: r.name ?? null })),
      ...input.bcc.map((r) => ({ role: "bcc", address: r.address, displayName: r.name ?? null })),
      ...(input.replyTo
        ? [
            {
              role: "reply_to",
              address: input.replyTo.address,
              displayName: input.replyTo.name ?? null,
            },
          ]
        : []),
    ]

    const detail = await deps.messages.create(
      ctx.workspaceId,
      {
        threadId,
        direction: "outbound",
        status: "queued",
        messageId,
        inReplyTo,
        referenceIds,
        subject: input.subject,
        fromAddress,
        fromName,
        bodyText,
        bodyHtml,
        snippet: emailSnippetOf(bodyText),
        connectionId: connection.id,
        providerId: connection.providerId,
        personId: input.personId ?? null,
        companyId: input.companyId ?? null,
        dealId: input.dealId ?? null,
        participants,
        attachments: input.attachments,
      },
      ctx.actorId,
    )

    // One hop: decrypt, hand to the adapter, forget. Never persisted, never
    // logged, never echoed back through an error message.
    const secret = await deps.secrets.readApiKey(ctx.workspaceId, connection.id)
    let sent
    try {
      sent = await transport.sendEmail(
        {
          messageId,
          inReplyTo,
          referenceIds,
          subject: input.subject,
          from: { address: fromAddress, name: fromName ?? null },
          to: input.to.map(toTransportAddress),
          cc: input.cc.map(toTransportAddress),
          bcc: input.bcc.map(toTransportAddress),
          replyTo: input.replyTo ? toTransportAddress(input.replyTo) : null,
          bodyText,
          bodyHtml,
        },
        {
          workspaceId: ctx.workspaceId,
          connectionId: connection.id,
          config: connection.config,
          secret,
        },
      )
    } catch (err) {
      const reason = reasonOf(err, secret)
      const failed = await deps.messages.update(
        ctx.workspaceId,
        detail.message.id,
        { status: "failed", lastError: reason, lastErrorAt: occurredAt },
        ctx.actorId,
      )
      await deps.audit({
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        action: "send_failed",
        object: "email_message",
        recordId: detail.message.id,
        after: { ...emailMessageSummary(failed ?? detail.message), lastError: reason },
        correlationId: ctx.correlationId,
      })
      throw new EmailSendFailedError(connection.providerId, reason)
    }

    const after = await deps.messages.update(
      ctx.workspaceId,
      detail.message.id,
      {
        status: sent.status ?? "sent",
        providerMessageId: sent.providerMessageId ?? null,
        sentAt: sent.sentAt ?? occurredAt,
        lastError: null,
        lastErrorAt: null,
      },
      ctx.actorId,
    )
    await deps.threads.refreshCounters(ctx.workspaceId, threadId, occurredAt)

    const stored = after ?? detail.message
    await events.emit(
      createEvent({
        event: CommunicationEvents.EmailSent,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "email_message",
        entityId: stored.id,
        after: emailMessageSummary(stored),
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "send",
      object: "email_message",
      recordId: stored.id,
      after: emailMessageSummary(stored),
      correlationId: ctx.correlationId,
    })
    return { ...detail, message: stored }
  }

  /**
   * Store a verified inbound message. Called from a provider's webhook
   * `handle()` — no session (see the service header).
   *
   * IDEMPOTENT: the framework may re-dispatch a delivery that previously
   * failed, so the first thing this does is look the normalised Message-ID
   * up. A hit returns the existing row and emits nothing.
   */
  async function receiveInboundEmail(rawInput: unknown): Promise<EmailInboundResult> {
    const input = inboundEmailMessageSchema.parse(rawInput)
    const workspaceId = input.workspaceId
    const messageId = normalizeEmailMessageId(input.messageId)

    if (messageId !== null) {
      const existing = await deps.messages.findByMessageId(workspaceId, messageId)
      if (existing) {
        return {
          status: "duplicate",
          threadId: existing.threadId,
          messageId: existing.id,
          threadReason: "existing",
        }
      }
    }

    const occurredAt = input.receivedAt ?? now()
    const inReplyTo = normalizeEmailMessageId(input.inReplyTo)
    const referenceIds = Array.isArray(input.references)
      ? input.references
      : (input.references ?? null)
    const recipients = [...input.to, ...input.cc, ...input.bcc]
    const addresses = [input.from.address, ...recipients.map((r) => r.address)]

    const resolution = await resolveEmailThread(deps.threads, {
      workspaceId,
      subject: input.subject,
      inReplyTo,
      references: referenceIds,
      addresses,
      activeSince: activeSince(),
    })
    let threadId = resolution.threadId
    if (threadId === null) {
      const thread = await deps.threads.create(workspaceId, {
        subject: input.subject ?? null,
        normalizedSubject: resolution.normalizedSubject,
        participantKey: resolution.participantKey,
        status: "open",
        lastMessageAt: occurredAt,
      })
      threadId = thread.id
    }

    // Provider HTML is scrubbed before it is stored, and the text we serve
    // is derived from the text part when there is one (see sanitize.ts).
    const bodyText = emailDisplayText(input.bodyText, input.bodyHtml)
    const bodyHtml = sanitizeEmailHtml(input.bodyHtml)
    const participants = [
      { role: "from", address: input.from.address, displayName: input.from.name ?? null },
      ...input.to.map((r) => ({ role: "to", address: r.address, displayName: r.name ?? null })),
      ...input.cc.map((r) => ({ role: "cc", address: r.address, displayName: r.name ?? null })),
      ...input.bcc.map((r) => ({ role: "bcc", address: r.address, displayName: r.name ?? null })),
      ...(input.replyTo
        ? [
            {
              role: "reply_to",
              address: input.replyTo.address,
              displayName: input.replyTo.name ?? null,
            },
          ]
        : []),
    ]

    const detail = await deps.messages.create(workspaceId, {
      threadId,
      direction: "inbound",
      status: "received",
      messageId,
      inReplyTo,
      referenceIds: Array.isArray(referenceIds) ? referenceIds : [],
      subject: input.subject ?? null,
      fromAddress: input.from.address,
      fromName: input.from.name ?? null,
      bodyText,
      bodyHtml,
      snippet: emailSnippetOf(bodyText),
      connectionId: input.connectionId ?? null,
      providerId: input.providerId ?? null,
      providerMessageId: input.providerMessageId ?? null,
      receivedAt: occurredAt,
      participants,
      attachments: input.attachments,
    })
    await deps.threads.refreshCounters(workspaceId, threadId, occurredAt)

    await events.emit(
      createEvent({
        event: CommunicationEvents.EmailReceived,
        workspaceId,
        actorType: "integration",
        entityType: "email_message",
        entityId: detail.message.id,
        after: emailMessageSummary(detail.message),
        correlationId: input.correlationId ?? undefined,
      }),
    )
    await deps.audit({
      workspaceId,
      actorId: null,
      action: "receive",
      object: "email_message",
      recordId: detail.message.id,
      after: emailMessageSummary(detail.message),
      correlationId: input.correlationId ?? null,
      source: "integration",
    })

    return {
      status: "created",
      threadId,
      messageId: detail.message.id,
      threadReason: resolution.reason,
    }
  }

  async function deleteThread(ctx: EmailServiceContext, id: string): Promise<EmailThreadRecord> {
    requirePermission(permissionOf(ctx, "email_thread", "delete"))
    const before = await deps.threads.findById(ctx.workspaceId, id)
    if (!before) throw new EmailThreadNotFoundError(id)
    await deps.threads.softDelete(ctx.workspaceId, id, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "email_thread",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  return {
    listThreads,
    getThread,
    getMessage,
    updateThread,
    sendMessage,
    receiveInboundEmail,
    deleteThread,
  }
}

export type EmailService = ReturnType<typeof createEmailService>
