import { and, asc, desc, eq, isNull, sql, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  isWhatsAppConversationStatus,
  isWhatsAppMessageDirection,
  isWhatsAppMessageKind,
  isWhatsAppMessageStatus,
  isWhatsAppTemplateStatus,
  whatsappConversations,
  whatsappMessages,
  whatsappTemplates,
  type NewWhatsAppConversationRow,
  type NewWhatsAppMessageRow,
  type NewWhatsAppTemplateRow,
  type WhatsAppConversationRow,
  type WhatsAppMessageRow,
  type WhatsAppMessageStatus,
  type WhatsAppTemplateRow,
} from "../schema/whatsapp"
import { createBaseRepository } from "./base-repository"

/* -------------------------------------------------------------------------
 * Phone normalisation
 * ---------------------------------------------------------------------- */

/**
 * Normalise a raw phone number (however the provider or a human typed it)
 * to E.164 (`+<countrycode><subscriber>`, digits only after the `+`).
 *
 * WhatsApp Cloud API sends inbound numbers as bare digits with no `+`
 * (`"14155552671"`); humans paste numbers with spaces, dashes, parens or a
 * leading `00` instead of `+`. All of those normalise to the same E.164
 * string, which is what `whatsapp_conversations` is keyed on — normalise on
 * every write path (inbound webhook, manual conversation creation) so the
 * same contact never splits into two conversations.
 */
export function normalizeWhatsAppPhone(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new Error("whatsapp: phone number must not be empty")

  // A leading "00" is the international dialling prefix some UIs use in
  // place of "+" — normalise it before stripping punctuation.
  const withPlus = trimmed.startsWith("00") ? `+${trimmed.slice(2)}` : trimmed
  const hadPlus = withPlus.trim().startsWith("+")
  const digits = withPlus.replace(/[^0-9]/g, "")
  if (digits.length === 0) throw new Error(`whatsapp: "${raw}" has no digits`)

  const candidate = hadPlus ? `+${digits}` : `+${digits}`
  // E.164: "+" followed by 8-15 digits, the first of which is non-zero.
  if (!/^\+[1-9]\d{7,14}$/.test(candidate)) {
    throw new Error(`whatsapp: "${raw}" does not normalise to a valid E.164 number`)
  }
  return candidate
}

/* -------------------------------------------------------------------------
 * Status transitions
 * ---------------------------------------------------------------------- */

/**
 * Monotonic rank for `whatsapp_messages.status`. A status webhook is only
 * applied when it strictly advances the rank of the message's CURRENT
 * status — this is what makes `applyMessageStatus` idempotent (the same
 * webhook replayed twice is a no-op the second time) and out-of-order safe
 * (a `delivered` webhook that lands after a `read` webhook has a lower rank
 * than the row's current `read` status, so it is ignored instead of
 * regressing the message).
 */
export const WHATSAPP_STATUS_RANK: Record<WhatsAppMessageStatus, number> = {
  queued: 0,
  sent: 1,
  failed: 2,
  delivered: 3,
  read: 4,
}

function statusRankSql(): SQL<number> {
  return sql<number>`CASE ${whatsappMessages.status}
    WHEN 'queued' THEN 0
    WHEN 'sent' THEN 1
    WHEN 'failed' THEN 2
    WHEN 'delivered' THEN 3
    WHEN 'read' THEN 4
    ELSE -1 END`
}

/* -------------------------------------------------------------------------
 * Input shapes
 * ---------------------------------------------------------------------- */

export type CreateWhatsAppConversationInput = {
  connectionId: string
  contactPhone: string
  personId?: string | null
  companyId?: string | null
  status?: string | null
}

export type UpdateWhatsAppConversationInput = {
  personId?: string | null
  companyId?: string | null
  status?: string | null
}

export type WhatsAppConversationListQuery = {
  workspaceId: string
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  status?: string
  personId?: string
  companyId?: string
  connectionId?: string
}

export type CreateWhatsAppMessageInput = {
  conversationId: string
  direction: string
  kind?: string
  body?: string | null
  templateId?: string | null
  templateVariables?: string[] | null
  mediaStorageKey?: string | null
  mediaContentType?: string | null
  mediaFileName?: string | null
  mediaSizeBytes?: number | null
  providerMessageId?: string | null
  status?: string | null
  occurredAt?: Date | null
}

export type CreateWhatsAppTemplateInput = {
  connectionId: string
  name: string
  language?: string | null
  category?: string | null
  status?: string | null
  bodyText: string
  variableCount?: number | null
}

function assertConversationStatus(status: string): string {
  if (!isWhatsAppConversationStatus(status)) {
    throw new Error("whatsapp.conversation: status must be one of open, archived")
  }
  return status
}

function assertMessageDirection(direction: string): string {
  if (!isWhatsAppMessageDirection(direction)) {
    throw new Error("whatsapp.message: direction must be one of inbound, outbound")
  }
  return direction
}

function assertMessageKind(kind: string): string {
  if (!isWhatsAppMessageKind(kind)) {
    throw new Error("whatsapp.message: unknown message kind")
  }
  return kind
}

function assertMessageStatus(status: string): WhatsAppMessageStatus {
  if (!isWhatsAppMessageStatus(status)) {
    throw new Error("whatsapp.message: status must be one of queued, sent, failed, delivered, read")
  }
  return status
}

function assertTemplateStatus(status: string): string {
  if (!isWhatsAppTemplateStatus(status)) {
    throw new Error("whatsapp.template: status must be one of pending, approved, rejected")
  }
  return status
}

/* -------------------------------------------------------------------------
 * Repository
 * ---------------------------------------------------------------------- */

/**
 * Workspace-scoped WhatsApp conversations, messages and templates.
 *
 * `connectionId` (the workspace's `integration_connections` row) is passed
 * in and stored verbatim — this repository never queries that table, since
 * it belongs to the integrations module.
 */
export function createWhatsAppRepository() {
  const conversationsBase = createBaseRepository(whatsappConversations)
  const templatesBase = createBaseRepository(whatsappTemplates)

  return {
    /* ---------------------------- conversations --------------------------- */

    async listConversations(db: Database, opts: WhatsAppConversationListQuery) {
      const where: SQL[] = []
      if (opts.status)
        where.push(eq(whatsappConversations.status, assertConversationStatus(opts.status)))
      if (opts.personId) where.push(eq(whatsappConversations.personId, opts.personId))
      if (opts.companyId) where.push(eq(whatsappConversations.companyId, opts.companyId))
      if (opts.connectionId) where.push(eq(whatsappConversations.connectionId, opts.connectionId))
      const result = await conversationsBase.list(db, { ...opts, where })
      return { data: result.data as WhatsAppConversationRow[], pagination: result.pagination }
    },

    async findConversationById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<WhatsAppConversationRow | null> {
      const row = await conversationsBase.findById(db, workspaceId, id)
      return (row as WhatsAppConversationRow | null) ?? null
    },

    async findConversationByPhone(
      db: Database,
      workspaceId: string,
      connectionId: string,
      contactPhone: string,
    ): Promise<WhatsAppConversationRow | null> {
      const phone = normalizeWhatsAppPhone(contactPhone)
      const rows = await db
        .select()
        .from(whatsappConversations)
        .where(
          and(
            eq(whatsappConversations.workspaceId, workspaceId),
            eq(whatsappConversations.connectionId, connectionId),
            eq(whatsappConversations.contactPhone, phone),
            isNull(whatsappConversations.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    /**
     * Find the conversation for (connection, contact phone), or create one.
     * Not fully race-proof by itself — two concurrent first messages from the
     * same brand-new contact could both miss the initial lookup — but the
     * unique index (`whatsapp_conversations_connection_phone_uidx`) backstops
     * it: a losing insert throws, and the caller re-reads the winning row.
     */
    async findOrCreateConversation(
      db: Database,
      workspaceId: string,
      input: CreateWhatsAppConversationInput,
      actorId?: string,
    ): Promise<{ row: WhatsAppConversationRow; created: boolean }> {
      const phone = normalizeWhatsAppPhone(input.contactPhone)
      const existing = await this.findConversationByPhone(
        db,
        workspaceId,
        input.connectionId,
        phone,
      )
      if (existing) return { row: existing, created: false }

      try {
        const rows = await db
          .insert(whatsappConversations)
          .values({
            workspaceId,
            connectionId: input.connectionId,
            contactPhone: phone,
            personId: input.personId ?? null,
            companyId: input.companyId ?? null,
            status: assertConversationStatus(input.status ?? "open"),
            ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
          } satisfies NewWhatsAppConversationRow)
          .returning()
        const row = rows[0]
        if (!row) throw new Error("whatsapp.findOrCreateConversation: insert returned no rows")
        return { row, created: true }
      } catch (err) {
        const retry = await this.findConversationByPhone(db, workspaceId, input.connectionId, phone)
        if (retry) return { row: retry, created: false }
        throw err
      }
    },

    async updateConversation(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateWhatsAppConversationInput,
      actorId?: string,
    ): Promise<WhatsAppConversationRow | null> {
      const values: Record<string, unknown> = { updatedAt: new Date() }
      if (input.personId !== undefined) values.personId = input.personId
      if (input.companyId !== undefined) values.companyId = input.companyId
      if (input.status !== undefined)
        values.status = assertConversationStatus(input.status ?? "open")
      if (actorId !== undefined) values.updatedBy = actorId
      const rows = await db
        .update(whatsappConversations)
        .set(values)
        .where(
          and(
            eq(whatsappConversations.id, id),
            eq(whatsappConversations.workspaceId, workspaceId),
            isNull(whatsappConversations.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    /** Bump conversation bookkeeping after an inbound message (opens the session window). */
    async touchInbound(
      db: Database,
      workspaceId: string,
      conversationId: string,
      occurredAt: Date,
      preview: string | null,
    ): Promise<void> {
      await db
        .update(whatsappConversations)
        .set({
          lastInboundAt: occurredAt,
          lastMessageAt: occurredAt,
          lastMessagePreview: preview,
          unreadCount: sql`${whatsappConversations.unreadCount} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(whatsappConversations.id, conversationId),
            eq(whatsappConversations.workspaceId, workspaceId),
          ),
        )
    },

    /** Bump conversation bookkeeping after an outbound message. */
    async touchOutbound(
      db: Database,
      workspaceId: string,
      conversationId: string,
      occurredAt: Date,
      preview: string | null,
    ): Promise<void> {
      await db
        .update(whatsappConversations)
        .set({
          lastOutboundAt: occurredAt,
          lastMessageAt: occurredAt,
          lastMessagePreview: preview,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(whatsappConversations.id, conversationId),
            eq(whatsappConversations.workspaceId, workspaceId),
          ),
        )
    },

    async markConversationRead(
      db: Database,
      workspaceId: string,
      conversationId: string,
    ): Promise<void> {
      await db
        .update(whatsappConversations)
        .set({ unreadCount: 0, updatedAt: new Date() })
        .where(
          and(
            eq(whatsappConversations.id, conversationId),
            eq(whatsappConversations.workspaceId, workspaceId),
          ),
        )
    },

    async softDeleteConversation(
      db: Database,
      workspaceId: string,
      id: string,
      actorId?: string,
    ): Promise<void> {
      await conversationsBase.softDelete(db, workspaceId, id, actorId)
    },

    /* ------------------------------- messages ------------------------------ */

    async listMessages(
      db: Database,
      workspaceId: string,
      conversationId: string,
      opts: { limit?: number; cursor?: string; order?: "asc" | "desc" } = {},
    ) {
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
      const ordering =
        opts.order === "desc" ? desc(whatsappMessages.createdAt) : asc(whatsappMessages.createdAt)
      const rows = await db
        .select()
        .from(whatsappMessages)
        .where(
          and(
            eq(whatsappMessages.conversationId, conversationId),
            eq(whatsappMessages.workspaceId, workspaceId),
            isNull(whatsappMessages.deletedAt),
          ),
        )
        .orderBy(ordering)
        .limit(limit + 1)
      const hasMore = rows.length > limit
      const data = hasMore ? rows.slice(0, limit) : rows
      const last = data[data.length - 1]
      return {
        data,
        pagination: { nextCursor: hasMore ? (last?.id ?? null) : null, limit },
      }
    },

    async findMessageById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<WhatsAppMessageRow | null> {
      const rows = await db
        .select()
        .from(whatsappMessages)
        .where(
          and(
            eq(whatsappMessages.id, id),
            eq(whatsappMessages.workspaceId, workspaceId),
            isNull(whatsappMessages.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    async findByProviderMessageId(
      db: Database,
      workspaceId: string,
      providerMessageId: string,
    ): Promise<WhatsAppMessageRow | null> {
      const rows = await db
        .select()
        .from(whatsappMessages)
        .where(
          and(
            eq(whatsappMessages.workspaceId, workspaceId),
            eq(whatsappMessages.providerMessageId, providerMessageId),
            isNull(whatsappMessages.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    /** Outbound: caller (the domain service) has already resolved the conversation. */
    async createMessage(
      db: Database,
      workspaceId: string,
      input: CreateWhatsAppMessageInput,
      actorId?: string,
    ): Promise<WhatsAppMessageRow> {
      const rows = await db
        .insert(whatsappMessages)
        .values({
          workspaceId,
          conversationId: input.conversationId,
          direction: assertMessageDirection(input.direction),
          kind: assertMessageKind(input.kind ?? "text"),
          body: input.body ?? null,
          templateId: input.templateId ?? null,
          templateVariables: input.templateVariables ?? null,
          mediaStorageKey: input.mediaStorageKey ?? null,
          mediaContentType: input.mediaContentType ?? null,
          mediaFileName: input.mediaFileName ?? null,
          mediaSizeBytes: input.mediaSizeBytes ?? null,
          providerMessageId: input.providerMessageId ?? null,
          status: assertMessageStatus(input.status ?? "queued"),
          statusUpdatedAt: input.occurredAt ?? new Date(),
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        } satisfies NewWhatsAppMessageRow)
        .returning()
      const row = rows[0]
      if (!row) throw new Error("whatsapp.createMessage: insert returned no rows")
      return row
    },

    /**
     * Direct update by id — used by the domain service to attach the
     * provider-assigned message id (and flip `queued` -> `sent`/`failed`)
     * once the send call returns. Unlike `applyMessageStatus`, this is keyed
     * by our own id (not `providerMessageId`, which is not known yet) and is
     * not rank-guarded: it is the ONE write that establishes the provider
     * message id in the first place, called at most once per send attempt.
     */
    async updateMessageById(
      db: Database,
      workspaceId: string,
      id: string,
      patch: {
        providerMessageId?: string | null
        status?: string
        error?: string | null
        occurredAt?: Date
      },
    ): Promise<WhatsAppMessageRow | null> {
      const values: Record<string, unknown> = { updatedAt: new Date() }
      if (patch.providerMessageId !== undefined) values.providerMessageId = patch.providerMessageId
      if (patch.status !== undefined) {
        const nextStatus = assertMessageStatus(patch.status)
        const occurredAt = patch.occurredAt ?? new Date()
        values.status = nextStatus
        values.statusUpdatedAt = occurredAt
        if (nextStatus === "sent") values.sentAt = occurredAt
        if (nextStatus === "delivered") values.deliveredAt = occurredAt
        if (nextStatus === "read") values.readAt = occurredAt
      }
      if (patch.error !== undefined) values.error = patch.error
      const rows = await db
        .update(whatsappMessages)
        .set(values)
        .where(
          and(
            eq(whatsappMessages.id, id),
            eq(whatsappMessages.workspaceId, workspaceId),
            isNull(whatsappMessages.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    /**
     * Inbound: idempotent on `providerMessageId` so a webhook delivery that is
     * replayed (the framework retries a previously-`failed` delivery, see
     * `IntegrationWebhookSpec.handle`) never creates a duplicate message.
     */
    async recordInboundMessage(
      db: Database,
      workspaceId: string,
      input: CreateWhatsAppMessageInput,
      actorId?: string,
    ): Promise<{ row: WhatsAppMessageRow; created: boolean }> {
      if (input.providerMessageId) {
        const existing = await this.findByProviderMessageId(
          db,
          workspaceId,
          input.providerMessageId,
        )
        if (existing) return { row: existing, created: false }
      }
      try {
        const row = await this.createMessage(
          db,
          workspaceId,
          { ...input, direction: "inbound", status: input.status ?? "delivered" },
          actorId,
        )
        return { row, created: true }
      } catch (err) {
        if (input.providerMessageId) {
          const existing = await this.findByProviderMessageId(
            db,
            workspaceId,
            input.providerMessageId,
          )
          if (existing) return { row: existing, created: false }
        }
        throw err
      }
    },

    /**
     * Apply a status transition only if it strictly advances the message's
     * rank (see `WHATSAPP_STATUS_RANK`). Returns the row in its FINAL state
     * either way — updated if the transition applied, unchanged if a
     * duplicate or out-of-order webhook was ignored, `null` if no message
     * with this `providerMessageId` exists yet.
     */
    async applyMessageStatus(
      db: Database,
      workspaceId: string,
      providerMessageId: string,
      status: string,
      patch: { error?: string | null; occurredAt?: Date } = {},
    ): Promise<{ row: WhatsAppMessageRow; applied: boolean } | null> {
      const nextStatus = assertMessageStatus(status)
      const rank = WHATSAPP_STATUS_RANK[nextStatus]
      const occurredAt = patch.occurredAt ?? new Date()

      const values: Record<string, unknown> = {
        status: nextStatus,
        statusUpdatedAt: occurredAt,
        updatedAt: new Date(),
      }
      if (nextStatus === "sent") values.sentAt = occurredAt
      if (nextStatus === "delivered") values.deliveredAt = occurredAt
      if (nextStatus === "read") values.readAt = occurredAt
      if (patch.error !== undefined) values.error = patch.error

      const rows = await db
        .update(whatsappMessages)
        .set(values)
        .where(
          and(
            eq(whatsappMessages.workspaceId, workspaceId),
            eq(whatsappMessages.providerMessageId, providerMessageId),
            isNull(whatsappMessages.deletedAt),
            sql`${statusRankSql()} < ${rank}`,
          ),
        )
        .returning()
      const updated = rows[0]
      if (updated) return { row: updated, applied: true }

      const current = await this.findByProviderMessageId(db, workspaceId, providerMessageId)
      return current ? { row: current, applied: false } : null
    },

    async softDeleteMessage(
      db: Database,
      workspaceId: string,
      id: string,
      actorId?: string,
    ): Promise<void> {
      await db
        .update(whatsappMessages)
        .set({ deletedAt: new Date(), ...(actorId ? { updatedBy: actorId } : {}) })
        .where(and(eq(whatsappMessages.id, id), eq(whatsappMessages.workspaceId, workspaceId)))
    },

    /* ------------------------------ templates ------------------------------ */

    async listTemplates(
      db: Database,
      workspaceId: string,
      opts: { connectionId?: string; limit?: number; cursor?: string; order?: "asc" | "desc" } = {},
    ) {
      const where: SQL[] = []
      if (opts.connectionId) where.push(eq(whatsappTemplates.connectionId, opts.connectionId))
      const result = await templatesBase.list(db, { workspaceId, ...opts, where })
      return { data: result.data as WhatsAppTemplateRow[], pagination: result.pagination }
    },

    async findTemplateById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<WhatsAppTemplateRow | null> {
      const row = await templatesBase.findById(db, workspaceId, id)
      return (row as WhatsAppTemplateRow | null) ?? null
    },

    async createTemplate(
      db: Database,
      workspaceId: string,
      input: CreateWhatsAppTemplateInput,
      actorId?: string,
    ): Promise<WhatsAppTemplateRow> {
      const name = input.name.trim()
      if (name.length === 0) throw new Error("whatsapp.template: name must not be empty")
      const rows = await db
        .insert(whatsappTemplates)
        .values({
          workspaceId,
          connectionId: input.connectionId,
          name,
          language: input.language?.trim() || "en_US",
          category: input.category ?? null,
          status: assertTemplateStatus(input.status ?? "approved"),
          bodyText: input.bodyText,
          variableCount: input.variableCount ?? 0,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        } satisfies NewWhatsAppTemplateRow)
        .returning()
      const row = rows[0]
      if (!row) throw new Error("whatsapp.createTemplate: insert returned no rows")
      return row
    },
  }
}

export type WhatsAppRepository = ReturnType<typeof createWhatsAppRepository>
