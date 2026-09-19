import { and, asc, desc, eq, gte, ilike, inArray, isNull, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  emailAttachments,
  emailMessages,
  emailParticipants,
  emailThreads,
  isEmailMessageDirection,
  isEmailMessageStatus,
  isEmailParticipantRole,
  isEmailThreadStatus,
  type EmailAttachment,
  type EmailMessage,
  type EmailParticipant,
  type EmailThread,
  type NewEmailMessage,
  type NewEmailThread,
} from "../schema/email"
import { createBaseRepository } from "./base-repository"

/**
 * Email module repository (spec 14-email, P0). Tables: `0210_email.sql`.
 *
 * WHO NORMALISES WHAT
 * -------------------
 * RFC 5322 header ids (`Message-ID`, `In-Reply-To`, `References`) arrive here
 * ALREADY NORMALISED — angle brackets stripped, trimmed, lower-cased — by
 * `normalizeEmailMessageId()` in `packages/crm/src/email/threading.ts`. That
 * normaliser is deliberately implemented exactly once, in the domain layer
 * that owns the threading rules: `email_messages_message_id_uidx` and every
 * ancestor lookup below compare raw column values, so two normalisers that
 * drifted apart would silently fragment conversations. This layer validates
 * shape (enum membership, address form, length) and nothing else.
 *
 * Bytes never land in Postgres: `email_attachments` keeps metadata and a
 * `storage_key` into `@yourcrm/storage`, like the `files` table.
 */

export type CreateEmailThreadInput = {
  subject?: string | null
  normalizedSubject: string
  participantKey: string
  status?: string | null
  ownerId?: string | null
  personId?: string | null
  companyId?: string | null
  dealId?: string | null
  lastMessageAt?: Date | null
}

export type UpdateEmailThreadInput = {
  subject?: string | null
  status?: string | null
  ownerId?: string | null
  personId?: string | null
  companyId?: string | null
  dealId?: string | null
  lastMessageAt?: Date | null
  messageCount?: number
}

export type EmailParticipantInput = {
  role: string
  address: string
  displayName?: string | null
  personId?: string | null
}

export type EmailAttachmentInput = {
  fileName: string
  mimeType?: string | null
  sizeBytes?: number | null
  storageKey?: string | null
  contentId?: string | null
  isInline?: boolean
}

export type CreateEmailMessageInput = {
  threadId: string
  direction: string
  status?: string | null
  messageId?: string | null
  inReplyTo?: string | null
  referenceIds?: string[]
  subject?: string | null
  fromAddress?: string | null
  fromName?: string | null
  bodyText?: string | null
  bodyHtml?: string | null
  snippet?: string | null
  connectionId?: string | null
  providerId?: string | null
  providerMessageId?: string | null
  sentAt?: Date | null
  receivedAt?: Date | null
  lastError?: string | null
  lastErrorAt?: Date | null
  personId?: string | null
  companyId?: string | null
  dealId?: string | null
  participants?: EmailParticipantInput[]
  attachments?: EmailAttachmentInput[]
}

export type UpdateEmailMessageInput = {
  status?: string | null
  providerMessageId?: string | null
  sentAt?: Date | null
  receivedAt?: Date | null
  lastError?: string | null
  lastErrorAt?: Date | null
  personId?: string | null
  companyId?: string | null
  dealId?: string | null
}

export type EmailMessageWithDetail = {
  message: EmailMessage
  participants: EmailParticipant[]
  attachments: EmailAttachment[]
}

export type EmailThreadWithMessages = {
  thread: EmailThread
  messages: EmailMessageWithDetail[]
}

/** One ancestor hit: which thread already contains this Message-ID. */
export type EmailAncestorMatch = {
  messageId: string
  threadId: string
}

const EMAIL_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Lower-cased, trimmed, shape-checked address (mirrors the 320 column). */
export function validateEmailParticipantAddress(address: string): string {
  const trimmed = address.trim().toLowerCase()
  if (!EMAIL_ADDRESS_RE.test(trimmed)) {
    throw new Error("email.participant: address must be a valid email address")
  }
  if (trimmed.length > 320) {
    throw new Error("email.participant: address must be at most 320 characters")
  }
  return trimmed
}

/** Header ids are pre-normalised by the domain layer — length only here. */
export function validateEmailHeaderId(value: string, field: string): string {
  if (value.length === 0) throw new Error(`email.message: ${field} must not be empty`)
  if (value.length > 998) {
    throw new Error(`email.message: ${field} must be at most 998 characters`)
  }
  return value
}

function assertEmailDirection(value: string): string {
  if (!isEmailMessageDirection(value)) {
    throw new Error("email.message: direction must be one of inbound, outbound")
  }
  return value
}

function assertEmailStatus(value: string): string {
  if (!isEmailMessageStatus(value)) {
    throw new Error(
      "email.message: status must be one of queued, sent, delivered, bounced, failed, received",
    )
  }
  return value
}

function assertEmailParticipantRole(value: string): string {
  if (!isEmailParticipantRole(value)) {
    throw new Error("email.participant: role must be one of from, to, cc, bcc, reply_to")
  }
  return value
}

function assertEmailThreadStatus(value: string): string {
  if (!isEmailThreadStatus(value)) {
    throw new Error("email.thread: status must be one of open, archived")
  }
  return value
}

/** Snippet is a display convenience — hard-truncate to the column width. */
function clampEmailSnippet(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const collapsed = value.replace(/\s+/g, " ").trim()
  return collapsed.length === 0 ? null : collapsed.slice(0, 280)
}

function toThreadValues(
  input: CreateEmailThreadInput | UpdateEmailThreadInput,
  actorId?: string,
): Partial<NewEmailThread> {
  const values: Partial<NewEmailThread> = {}
  if (input.subject !== undefined) values.subject = input.subject
  if ("normalizedSubject" in input && input.normalizedSubject !== undefined) {
    values.normalizedSubject = input.normalizedSubject
  }
  if ("participantKey" in input && input.participantKey !== undefined) {
    values.participantKey = input.participantKey
  }
  if (input.status !== undefined && input.status !== null) {
    values.status = assertEmailThreadStatus(input.status)
  }
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.personId !== undefined) values.personId = input.personId
  if (input.companyId !== undefined) values.companyId = input.companyId
  if (input.dealId !== undefined) values.dealId = input.dealId
  if (input.lastMessageAt !== undefined) values.lastMessageAt = input.lastMessageAt
  if ("messageCount" in input && input.messageCount !== undefined) {
    values.messageCount = input.messageCount
  }
  if (actorId !== undefined) values.updatedBy = actorId
  return values
}

function toMessageValues(
  input: CreateEmailMessageInput | UpdateEmailMessageInput,
  actorId?: string,
): Partial<NewEmailMessage> {
  const values: Partial<NewEmailMessage> = {}
  if ("direction" in input && input.direction !== undefined) {
    values.direction = assertEmailDirection(input.direction)
  }
  if (input.status !== undefined && input.status !== null) {
    values.status = assertEmailStatus(input.status)
  }
  if ("messageId" in input && input.messageId !== undefined) {
    values.messageId =
      input.messageId === null ? null : validateEmailHeaderId(input.messageId, "messageId")
  }
  if ("inReplyTo" in input && input.inReplyTo !== undefined) {
    values.inReplyTo =
      input.inReplyTo === null ? null : validateEmailHeaderId(input.inReplyTo, "inReplyTo")
  }
  if ("referenceIds" in input && input.referenceIds !== undefined) {
    values.referenceIds = input.referenceIds.map((id) => validateEmailHeaderId(id, "referenceIds"))
  }
  if ("subject" in input && input.subject !== undefined) values.subject = input.subject
  if ("fromAddress" in input && input.fromAddress !== undefined) {
    values.fromAddress =
      input.fromAddress === null ? null : validateEmailParticipantAddress(input.fromAddress)
  }
  if ("fromName" in input && input.fromName !== undefined) values.fromName = input.fromName
  if ("bodyText" in input && input.bodyText !== undefined) values.bodyText = input.bodyText
  if ("bodyHtml" in input && input.bodyHtml !== undefined) values.bodyHtml = input.bodyHtml
  if ("snippet" in input && input.snippet !== undefined) {
    values.snippet = clampEmailSnippet(input.snippet)
  }
  if ("connectionId" in input && input.connectionId !== undefined) {
    values.connectionId = input.connectionId
  }
  if ("providerId" in input && input.providerId !== undefined) values.providerId = input.providerId
  if (input.providerMessageId !== undefined) values.providerMessageId = input.providerMessageId
  if (input.sentAt !== undefined) values.sentAt = input.sentAt
  if (input.receivedAt !== undefined) values.receivedAt = input.receivedAt
  if (input.lastError !== undefined) values.lastError = input.lastError
  if (input.lastErrorAt !== undefined) values.lastErrorAt = input.lastErrorAt
  if (input.personId !== undefined) values.personId = input.personId
  if (input.companyId !== undefined) values.companyId = input.companyId
  if (input.dealId !== undefined) values.dealId = input.dealId
  if (actorId !== undefined) values.updatedBy = actorId
  return values
}

/**
 * Workspace-scoped email threads, messages, participants and attachment
 * metadata. Threading lookups (`findThreadIdsByMessageIds`,
 * `findThreadByMatch`) are the queries the domain algorithm runs; everything
 * else is ordinary CRUD over the four tables.
 */
export function createEmailRepository() {
  const threadBase = createBaseRepository(emailThreads)
  const messageBase = createBaseRepository(emailMessages)

  async function loadMessageDetail(
    db: Database,
    workspaceId: string,
    messages: EmailMessage[],
  ): Promise<EmailMessageWithDetail[]> {
    if (messages.length === 0) return []
    const ids = messages.map((m) => m.id)
    const [participants, attachments] = await Promise.all([
      db
        .select()
        .from(emailParticipants)
        .where(
          and(
            eq(emailParticipants.workspaceId, workspaceId),
            inArray(emailParticipants.emailMessageId, ids),
            isNull(emailParticipants.deletedAt),
          ),
        ),
      db
        .select()
        .from(emailAttachments)
        .where(
          and(
            eq(emailAttachments.workspaceId, workspaceId),
            inArray(emailAttachments.emailMessageId, ids),
            isNull(emailAttachments.deletedAt),
          ),
        ),
    ])
    return messages.map((message) => ({
      message,
      participants: participants.filter((p) => p.emailMessageId === message.id),
      attachments: attachments.filter((a) => a.emailMessageId === message.id),
    }))
  }

  return {
    ...threadBase,

    /* ------------------------------ threads ----------------------------- */

    async createThread(
      db: Database,
      workspaceId: string,
      input: CreateEmailThreadInput,
      actorId?: string,
    ): Promise<EmailThread> {
      const rows = await db
        .insert(emailThreads)
        .values({
          ...toThreadValues(input, actorId),
          workspaceId,
          normalizedSubject: input.normalizedSubject,
          participantKey: input.participantKey,
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("email.createThread: insert returned no rows")
      return row
    },

    async updateThread(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateEmailThreadInput,
      actorId?: string,
    ): Promise<EmailThread | null> {
      const rows = await db
        .update(emailThreads)
        .set({ ...toThreadValues(input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(emailThreads.id, id),
            eq(emailThreads.workspaceId, workspaceId),
            isNull(emailThreads.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async findThreadById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<EmailThread | null> {
      return (await threadBase.findById(db, workspaceId, id)) as EmailThread | null
    },

    /** Cursor-paginated thread list, newest activity first by default. */
    async searchThreads(
      db: Database,
      opts: {
        workspaceId: string
        limit?: number
        cursor?: string
        order?: "asc" | "desc"
        query?: string
        status?: string
        personId?: string
        companyId?: string
        dealId?: string
      },
    ) {
      const where: SQL[] = []
      if (opts.query) where.push(ilike(emailThreads.subject, `%${opts.query.trim()}%`))
      if (opts.status) where.push(eq(emailThreads.status, assertEmailThreadStatus(opts.status)))
      if (opts.personId) where.push(eq(emailThreads.personId, opts.personId))
      if (opts.companyId) where.push(eq(emailThreads.companyId, opts.companyId))
      if (opts.dealId) where.push(eq(emailThreads.dealId, opts.dealId))
      const result = await threadBase.list(db, { ...opts, where })
      return { data: result.data as EmailThread[], pagination: result.pagination }
    },

    async findThreadWithMessages(
      db: Database,
      workspaceId: string,
      threadId: string,
    ): Promise<EmailThreadWithMessages | null> {
      const thread = await this.findThreadById(db, workspaceId, threadId)
      if (!thread) return null
      const messages = await this.listMessagesByThread(db, workspaceId, threadId)
      return { thread, messages: await loadMessageDetail(db, workspaceId, messages) }
    },

    /* ----------------------------- threading ---------------------------- */

    /**
     * Ancestor lookup: which threads already hold these Message-IDs? Ids must
     * be normalised (see the header). Returns one row per match so the domain
     * algorithm can prefer the nearest ancestor.
     */
    async findThreadIdsByMessageIds(
      db: Database,
      workspaceId: string,
      messageIds: readonly string[],
    ): Promise<EmailAncestorMatch[]> {
      if (messageIds.length === 0) return []
      const rows = await db
        .select({ messageId: emailMessages.messageId, threadId: emailMessages.threadId })
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.workspaceId, workspaceId),
            inArray(emailMessages.messageId, [...messageIds]),
            isNull(emailMessages.deletedAt),
          ),
        )
      return rows.flatMap((row) =>
        row.messageId === null ? [] : [{ messageId: row.messageId, threadId: row.threadId }],
      )
    },

    /**
     * Subject + participant-set fallback. Both keys must match, and the
     * thread must have been active since `activeSince` when supplied — an
     * unbounded match would glue a years-old thread to a fresh message that
     * merely reuses its subject line.
     */
    async findThreadByMatch(
      db: Database,
      workspaceId: string,
      match: { normalizedSubject: string; participantKey: string; activeSince?: Date | null },
    ): Promise<EmailThread | null> {
      if (match.normalizedSubject.length === 0 || match.participantKey.length === 0) return null
      const where: SQL[] = [
        eq(emailThreads.workspaceId, workspaceId),
        eq(emailThreads.normalizedSubject, match.normalizedSubject),
        eq(emailThreads.participantKey, match.participantKey),
        isNull(emailThreads.deletedAt),
      ]
      if (match.activeSince) where.push(gte(emailThreads.lastMessageAt, match.activeSince))
      const rows = await db
        .select()
        .from(emailThreads)
        .where(and(...where))
        .orderBy(desc(emailThreads.lastMessageAt))
        .limit(1)
      return rows[0] ?? null
    },

    /* ----------------------------- messages ----------------------------- */

    /**
     * Insert a message plus its participants and attachment metadata, then
     * roll the thread's counters forward. The caller has already resolved
     * `threadId` through the threading algorithm.
     */
    async createMessage(
      db: Database,
      workspaceId: string,
      input: CreateEmailMessageInput,
      actorId?: string,
    ): Promise<EmailMessageWithDetail> {
      const rows = await db
        .insert(emailMessages)
        .values({
          ...toMessageValues(input, actorId),
          workspaceId,
          threadId: input.threadId,
          direction: assertEmailDirection(input.direction),
          hasAttachments: (input.attachments ?? []).length > 0,
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const message = rows[0]
      if (!message) throw new Error("email.createMessage: insert returned no rows")

      const participants: EmailParticipant[] = []
      for (const participant of input.participants ?? []) {
        const inserted = await db
          .insert(emailParticipants)
          .values({
            workspaceId,
            emailMessageId: message.id,
            threadId: input.threadId,
            role: assertEmailParticipantRole(participant.role),
            address: validateEmailParticipantAddress(participant.address),
            displayName: participant.displayName?.trim() || null,
            personId: participant.personId ?? null,
            ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
          })
          .returning()
        const row = inserted[0]
        if (row) participants.push(row)
      }

      const attachments: EmailAttachment[] = []
      for (const attachment of input.attachments ?? []) {
        const inserted = await db
          .insert(emailAttachments)
          .values({
            workspaceId,
            emailMessageId: message.id,
            fileName: attachment.fileName.trim().slice(0, 255),
            mimeType: attachment.mimeType ?? null,
            sizeBytes: attachment.sizeBytes ?? 0,
            storageKey: attachment.storageKey ?? null,
            contentId: attachment.contentId ?? null,
            isInline: attachment.isInline ?? false,
            ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
          })
          .returning()
        const row = inserted[0]
        if (row) attachments.push(row)
      }

      return { message, participants, attachments }
    },

    async updateMessage(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateEmailMessageInput,
      actorId?: string,
    ): Promise<EmailMessage | null> {
      const rows = await db
        .update(emailMessages)
        .set({ ...toMessageValues(input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(emailMessages.id, id),
            eq(emailMessages.workspaceId, workspaceId),
            isNull(emailMessages.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async findMessageById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<EmailMessage | null> {
      return (await messageBase.findById(db, workspaceId, id)) as EmailMessage | null
    },

    /** Webhook idempotency probe: has this Message-ID already been stored? */
    async findMessageByMessageId(
      db: Database,
      workspaceId: string,
      messageId: string,
    ): Promise<EmailMessage | null> {
      const rows = await db
        .select()
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.workspaceId, workspaceId),
            eq(emailMessages.messageId, messageId),
            isNull(emailMessages.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    async listMessagesByThread(
      db: Database,
      workspaceId: string,
      threadId: string,
      limit = 200,
    ): Promise<EmailMessage[]> {
      return db
        .select()
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.workspaceId, workspaceId),
            eq(emailMessages.threadId, threadId),
            isNull(emailMessages.deletedAt),
          ),
        )
        .orderBy(asc(emailMessages.createdAt))
        .limit(limit)
    },

    async findMessageWithDetail(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<EmailMessageWithDetail | null> {
      const message = await this.findMessageById(db, workspaceId, id)
      if (!message) return null
      const [detail] = await loadMessageDetail(db, workspaceId, [message])
      return detail ?? { message, participants: [], attachments: [] }
    },

    async softDeleteMessage(
      db: Database,
      workspaceId: string,
      id: string,
      actorId?: string,
    ): Promise<void> {
      await messageBase.softDelete(db, workspaceId, id, actorId)
    },

    /**
     * Roll the thread forward after a message lands. `messageCount` is
     * recomputed from the rows rather than incremented, so a retried webhook
     * that did not insert anything cannot inflate it.
     */
    async refreshThreadCounters(
      db: Database,
      workspaceId: string,
      threadId: string,
      lastMessageAt: Date,
    ): Promise<EmailThread | null> {
      const rows = await db
        .select({ id: emailMessages.id })
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.workspaceId, workspaceId),
            eq(emailMessages.threadId, threadId),
            isNull(emailMessages.deletedAt),
          ),
        )
      return this.updateThread(db, workspaceId, threadId, {
        messageCount: rows.length,
        lastMessageAt,
      })
    },
  }
}

export type EmailRepository = ReturnType<typeof createEmailRepository>
