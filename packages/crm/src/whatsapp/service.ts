import { CommunicationEvents, createEvent, getEventBus } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import { redactIntegrationSecrets } from "../integrations"
import {
  createWhatsAppConversationSchema,
  createWhatsAppTemplateSchema,
  sendWhatsAppMessageSchema,
  updateWhatsAppConversationSchema,
  whatsAppConversationQuerySchema,
  whatsAppMessageQuerySchema,
} from "./schemas"
import { isWhatsAppSessionWindowOpen } from "./session-window"
import type {
  WhatsAppConversationRecord,
  WhatsAppInboundMessageInput,
  WhatsAppInboundStatusInput,
  WhatsAppListResult,
  WhatsAppMessageRecord,
  WhatsAppServiceContext,
  WhatsAppServiceDeps,
  WhatsAppTemplateRecord,
} from "./types"

/* --------------------------------- errors -------------------------------- */

export class WhatsAppConversationNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`whatsapp conversation ${id} not found`)
    this.name = "WhatsAppConversationNotFoundError"
  }
}

export class WhatsAppTemplateNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`whatsapp template ${id} not found for this conversation's connection`)
    this.name = "WhatsAppTemplateNotFoundError"
  }
}

/** The 24h WhatsApp Business session window is closed: only a template may be sent. */
export class WhatsAppSessionWindowClosedError extends Error {
  readonly code = "WHATSAPP_SESSION_WINDOW_CLOSED"
  constructor(conversationId: string) {
    super(
      `conversation ${conversationId} is outside the 24h session window — send an approved template instead of free text`,
    )
    this.name = "WhatsAppSessionWindowClosedError"
  }
}

export class WhatsAppTemplateNotApprovedError extends Error {
  readonly code = "TEMPLATE_NOT_APPROVED"
  constructor(templateId: string) {
    super(`template ${templateId} is not approved and cannot be sent`)
    this.name = "WhatsAppTemplateNotApprovedError"
  }
}

export class WhatsAppNotConnectedError extends Error {
  readonly code = "WHATSAPP_NOT_CONNECTED"
  constructor(connectionId: string) {
    super(`whatsapp connection ${connectionId} is not connected or has no stored credential`)
    this.name = "WhatsAppNotConnectedError"
  }
}

/** The provider adapter rejected or failed the send call. Reason is already redacted. */
export class WhatsAppSendFailedError extends Error {
  readonly code = "WHATSAPP_SEND_FAILED"
  constructor(reason: string) {
    super(`failed to send WhatsApp message: ${reason}`)
    this.name = "WhatsAppSendFailedError"
  }
}

/* --------------------------------- helpers -------------------------------- */

function permissionOf(
  ctx: WhatsAppServiceContext,
  object: "whatsapp_conversation" | "whatsapp_message" | "whatsapp_template",
  action: "read" | "create" | "update" | "send_external",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object,
    action,
  }
}

function preview(text: string | null | undefined, max = 140): string | null {
  if (!text) return null
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/** `image`/`document`/`audio`/`video` pass through; anything else is `unknown` (never `text`/`template`). */
function mapInboundMediaKind(kind: string): string {
  return ["image", "document", "audio", "video", "interactive"].includes(kind) ? kind : "unknown"
}

/** Substitutes `{{1}}`, `{{2}}`, … for a friendly preview stored alongside the send. */
function renderTemplatePreview(bodyText: string, variables: readonly string[]): string {
  return bodyText.replace(/\{\{(\d+)\}\}/g, (match, index: string) => {
    const value = variables[Number(index) - 1]
    return value ?? match
  })
}

function countTemplateVariables(bodyText: string): number {
  const indices = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))
  return indices.length === 0 ? 0 : Math.max(...indices)
}

function reasonOf(err: unknown, ...secrets: (string | null | undefined)[]): string {
  const raw = err instanceof Error ? err.message : String(err)
  return redactIntegrationSecrets(raw, ...secrets)
}

/* --------------------------------- service --------------------------------
 *
 * Every ctx-taking method:
 *  1. calls `requirePermission()` FIRST;
 *  2. works through the injected stores/connection port/provider adapter;
 *  3. emits `CommunicationEvents.MessageReceived`/`MessageSent` (never a
 *     string literal) and writes an audit row for mutations.
 *
 * `ingestInboundMessage` / `ingestStatusUpdate` are the exception, same as
 * `IntegrationsService.ingestWebhook`: their caller is a verified provider
 * webhook delivery, not a user session, so there is nothing to permission-
 * check — the framework's HMAC verification IS the authentication. Both are
 * idempotent (see `whatsapp-repository.ts`), because the framework may
 * re-invoke a provider's `handle()` for a previously failed delivery.
 * ---------------------------------------------------------------------- */

export function createWhatsAppService(deps: WhatsAppServiceDeps) {
  const events = deps.events ?? getEventBus()
  const now = deps.now ?? (() => new Date())

  async function listConversations(
    ctx: WhatsAppServiceContext,
    rawQuery: unknown,
  ): Promise<WhatsAppListResult<WhatsAppConversationRecord>> {
    requirePermission(permissionOf(ctx, "whatsapp_conversation", "read"))
    const query = whatsAppConversationQuerySchema.parse(rawQuery)
    return deps.conversations.list(ctx.workspaceId, query)
  }

  async function getConversation(
    ctx: WhatsAppServiceContext,
    id: string,
  ): Promise<WhatsAppConversationRecord> {
    requirePermission(permissionOf(ctx, "whatsapp_conversation", "read"))
    const found = await deps.conversations.findById(ctx.workspaceId, id)
    if (!found) throw new WhatsAppConversationNotFoundError(id)
    return found
  }

  async function createConversation(
    ctx: WhatsAppServiceContext,
    rawInput: unknown,
  ): Promise<WhatsAppConversationRecord> {
    requirePermission(permissionOf(ctx, "whatsapp_conversation", "create"))
    const input = createWhatsAppConversationSchema.parse(rawInput)
    const { record } = await deps.conversations.findOrCreate(
      ctx.workspaceId,
      input as unknown as Record<string, unknown>,
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "whatsapp_conversation",
      recordId: record.id,
      after: record,
      correlationId: ctx.correlationId,
    })
    return record
  }

  async function updateConversation(
    ctx: WhatsAppServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<WhatsAppConversationRecord> {
    requirePermission(permissionOf(ctx, "whatsapp_conversation", "update"))
    const patch = updateWhatsAppConversationSchema.parse(rawPatch)
    const before = await deps.conversations.findById(ctx.workspaceId, id)
    if (!before) throw new WhatsAppConversationNotFoundError(id)
    const after = await deps.conversations.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new WhatsAppConversationNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "whatsapp_conversation",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function markConversationRead(
    ctx: WhatsAppServiceContext,
    id: string,
  ): Promise<WhatsAppConversationRecord> {
    requirePermission(permissionOf(ctx, "whatsapp_conversation", "update"))
    const found = await deps.conversations.findById(ctx.workspaceId, id)
    if (!found) throw new WhatsAppConversationNotFoundError(id)
    await deps.conversations.markRead(ctx.workspaceId, id)
    return (await deps.conversations.findById(ctx.workspaceId, id)) ?? found
  }

  async function listMessages(
    ctx: WhatsAppServiceContext,
    conversationId: string,
    rawQuery: unknown,
  ): Promise<WhatsAppListResult<WhatsAppMessageRecord>> {
    requirePermission(permissionOf(ctx, "whatsapp_conversation", "read"))
    const conversation = await deps.conversations.findById(ctx.workspaceId, conversationId)
    if (!conversation) throw new WhatsAppConversationNotFoundError(conversationId)
    const query = whatsAppMessageQuerySchema.parse(rawQuery)
    return deps.messages.list(ctx.workspaceId, conversationId, query)
  }

  /**
   * Send an outbound message. Enforces the 24h session window server-side —
   * `kind: "text"` is rejected outside it, `kind: "template"` always works
   * (that IS how a business re-opens a closed conversation).
   */
  async function sendMessage(
    ctx: WhatsAppServiceContext,
    conversationId: string,
    rawInput: unknown,
  ): Promise<WhatsAppMessageRecord> {
    requirePermission(permissionOf(ctx, "whatsapp_message", "send_external"))
    const input = sendWhatsAppMessageSchema.parse(rawInput)
    const conversation = await deps.conversations.findById(ctx.workspaceId, conversationId)
    if (!conversation) throw new WhatsAppConversationNotFoundError(conversationId)

    let body: string | null
    let templateId: string | null = null
    let templateVariables: string[] | null = null
    let templateName: string | null = null
    let templateLanguage = "en_US"

    if (input.kind === "text") {
      const lastInboundAt = conversation.lastInboundAt as Date | string | null | undefined
      if (!isWhatsAppSessionWindowOpen(lastInboundAt, now())) {
        throw new WhatsAppSessionWindowClosedError(conversationId)
      }
      body = input.body
    } else {
      const template = await deps.templates.findById(ctx.workspaceId, input.templateId)
      // Cross-connection templates fail the same way as an unknown id —
      // this endpoint never confirms a template exists on another connection.
      if (!template || template.connectionId !== conversation.connectionId) {
        throw new WhatsAppTemplateNotFoundError(input.templateId)
      }
      if (template.status !== "approved") throw new WhatsAppTemplateNotApprovedError(template.id)
      templateId = template.id
      templateVariables = [...input.variables]
      templateName = template.name
      templateLanguage = String((template as Record<string, unknown>).language ?? "en_US")
      body = renderTemplatePreview(template.bodyText, templateVariables)
    }

    const connection = await deps.connections.findById(ctx.workspaceId, conversation.connectionId)
    if (!connection || connection.status !== "connected") {
      throw new WhatsAppNotConnectedError(conversation.connectionId)
    }
    const secret = await deps.connections.readSecret(ctx.workspaceId, connection.id)
    if (!secret) throw new WhatsAppNotConnectedError(conversation.connectionId)

    // Persisted BEFORE the provider call so a send failure still leaves a
    // visible `failed` row instead of silently dropping the attempt.
    const created = await deps.messages.create(
      ctx.workspaceId,
      {
        conversationId: conversation.id,
        direction: "outbound",
        kind: input.kind,
        body,
        templateId,
        templateVariables,
        status: "queued",
      },
      ctx.actorId,
    )

    let result: { providerMessageId: string }
    try {
      result =
        input.kind === "text"
          ? await deps.provider.sendText({
              workspaceId: ctx.workspaceId,
              connectionId: connection.id,
              config: connection.config,
              secret,
              to: conversation.contactPhone,
              body: body ?? "",
            })
          : await deps.provider.sendTemplate({
              workspaceId: ctx.workspaceId,
              connectionId: connection.id,
              config: connection.config,
              secret,
              to: conversation.contactPhone,
              templateName: templateName ?? "",
              language: templateLanguage,
              variables: templateVariables ?? [],
            })
    } catch (err) {
      const reason = reasonOf(err, secret)
      await deps.messages.update(ctx.workspaceId, created.id, {
        status: "failed",
        error: reason,
        occurredAt: now(),
      })
      await deps.audit({
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        action: "send_failed",
        object: "whatsapp_message",
        recordId: created.id,
        after: { status: "failed", error: reason },
        correlationId: ctx.correlationId,
      })
      throw new WhatsAppSendFailedError(reason)
    }

    const occurredAt = now()
    const sent = await deps.messages.update(ctx.workspaceId, created.id, {
      providerMessageId: result.providerMessageId,
      status: "sent",
      occurredAt,
    })
    const final = sent ?? created
    await deps.conversations.touchOutbound(
      ctx.workspaceId,
      conversation.id,
      occurredAt,
      preview(body),
    )

    await events.emit(
      createEvent({
        event: CommunicationEvents.MessageSent,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "whatsapp_message",
        entityId: final.id,
        after: final,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "send",
      object: "whatsapp_message",
      recordId: final.id,
      after: final,
      correlationId: ctx.correlationId,
    })
    return final
  }

  async function listTemplates(
    ctx: WhatsAppServiceContext,
    connectionId?: string,
  ): Promise<WhatsAppListResult<WhatsAppTemplateRecord>> {
    requirePermission(permissionOf(ctx, "whatsapp_template", "read"))
    return deps.templates.list(ctx.workspaceId, { connectionId })
  }

  async function createTemplate(
    ctx: WhatsAppServiceContext,
    rawInput: unknown,
  ): Promise<WhatsAppTemplateRecord> {
    requirePermission(permissionOf(ctx, "whatsapp_template", "create"))
    const input = createWhatsAppTemplateSchema.parse(rawInput)
    const record = await deps.templates.create(
      ctx.workspaceId,
      { ...input, variableCount: countTemplateVariables(input.bodyText) },
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "whatsapp_template",
      recordId: record.id,
      after: record,
      correlationId: ctx.correlationId,
    })
    return record
  }

  /**
   * Inbound webhook delivery -> conversation keyed on the contact's E.164
   * phone (normalised at the repository write boundary), appended message.
   * Idempotent on `providerMessageId`: a replayed delivery is a no-op past
   * `deps.messages.recordInbound`, so no duplicate event/audit is emitted.
   */
  async function ingestInboundMessage(input: WhatsAppInboundMessageInput): Promise<{
    conversation: WhatsAppConversationRecord
    message: WhatsAppMessageRecord
    created: boolean
  }> {
    const { record: conversation } = await deps.conversations.findOrCreate(
      input.workspaceId,
      { connectionId: input.connectionId, contactPhone: input.from },
      undefined,
    )
    const kind = input.media ? mapInboundMediaKind(input.media.kind) : "text"
    const { record: message, created } = await deps.messages.recordInbound(
      input.workspaceId,
      {
        conversationId: conversation.id,
        direction: "inbound",
        kind,
        body: input.text ?? null,
        mediaStorageKey: input.media?.storageKey ?? null,
        mediaContentType: input.media?.contentType ?? null,
        mediaFileName: input.media?.fileName ?? null,
        mediaSizeBytes: input.media?.sizeBytes ?? null,
        providerMessageId: input.providerMessageId,
        status: "delivered",
        occurredAt: input.occurredAt,
      },
      undefined,
    )

    if (created) {
      await deps.conversations.touchInbound(
        input.workspaceId,
        conversation.id,
        input.occurredAt,
        preview(input.text ?? null),
      )
      await events.emit(
        createEvent({
          event: CommunicationEvents.MessageReceived,
          workspaceId: input.workspaceId,
          actorType: "integration",
          entityType: "whatsapp_message",
          entityId: message.id,
          after: message,
          correlationId: input.correlationId,
        }),
      )
      await deps.audit({
        workspaceId: input.workspaceId,
        actorId: null,
        action: "receive",
        object: "whatsapp_message",
        recordId: message.id,
        after: message,
        correlationId: input.correlationId,
        source: "integration",
      })
    }
    return { conversation, message, created }
  }

  /** Inbound status webhook (`sent`/`delivered`/`read`/`failed`) — idempotent, out-of-order safe. */
  async function ingestStatusUpdate(
    input: WhatsAppInboundStatusInput,
  ): Promise<{ message: WhatsAppMessageRecord; applied: boolean } | null> {
    const result = await deps.messages.applyStatus(
      input.workspaceId,
      input.providerMessageId,
      input.status,
      { error: input.error ?? null, occurredAt: input.occurredAt },
    )
    if (!result) return null
    if (result.applied) {
      await deps.audit({
        workspaceId: input.workspaceId,
        actorId: null,
        action: "status_update",
        object: "whatsapp_message",
        recordId: result.record.id,
        after: { status: result.record.status },
        correlationId: input.correlationId,
        source: "integration",
      })
    }
    return { message: result.record, applied: result.applied }
  }

  return {
    listConversations,
    getConversation,
    createConversation,
    updateConversation,
    markConversationRead,
    listMessages,
    sendMessage,
    listTemplates,
    createTemplate,
    ingestInboundMessage,
    ingestStatusUpdate,
  }
}

export type WhatsAppService = ReturnType<typeof createWhatsAppService>
