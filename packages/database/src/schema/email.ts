import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Email module tables (spec 14-email, P0). Migration `0210_email.sql`.
 *
 * SCOPE: provider-delivered email only. No IMAP/POP polling, no OAuth, no
 * raw RFC822/MIME parsing — the module accepts *structured* payloads from an
 * `@yourcrm/integrations` provider (outbound through the provider adapter,
 * inbound through the framework's signed webhook) and stores the result.
 * Templates, tracking pixels, scheduled send and sequences are P1.
 *
 * THREADING is the technical core and lives in
 * `packages/crm/src/email/threading.ts`. The columns that make it work:
 *
 * - `email_messages.message_id` — the RFC 5322 `Message-ID`, normalised
 *   (angle brackets stripped, lower-cased). Unique per workspace so a
 *   re-delivered webhook cannot create a second row for the same message.
 * - `email_messages.in_reply_to` + `email_messages.reference_ids` — the
 *   parent and the ancestor chain, normalised the same way. `reference_ids`
 *   is `reference_ids`, NOT `references`: `REFERENCES` is a reserved word in
 *   SQL and would need quoting everywhere.
 * - `email_threads.normalized_subject` + `email_threads.participant_key` —
 *   the fallback used when a message carries no usable reference chain.
 *   `participant_key` is a sha256 hex digest of the thread's sorted,
 *   de-duplicated address set, so the pair is a cheap composite index
 *   lookup instead of a set comparison in SQL.
 *
 * ATTACHMENTS hold metadata only. Bytes live in S3/MinIO via
 * `@yourcrm/storage` and are addressed by `storage_key`, exactly like the
 * `files` table (spec 29). Nothing in this module writes bytes to Postgres.
 *
 * CROSS-MODULE LINKS: `person_id`, `company_id` and `deal_id` are PLAIN uuid
 * columns with an index and NO foreign key — those tables belong to other
 * module agents (same rule as `people.company_id`). `connection_id` points
 * at `integration_connections`, which this module does not own, so it is a
 * plain uuid too. `thread_id`, `email_message_id` and the participant/
 * attachment parents ARE real foreign keys: every one of those tables is
 * defined in this module's own migration.
 */

/** Which way the message travelled. */
export const EMAIL_MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const

export type EmailMessageDirection = (typeof EMAIL_MESSAGE_DIRECTIONS)[number]

export function isEmailMessageDirection(value: unknown): value is EmailMessageDirection {
  return (
    typeof value === "string" && (EMAIL_MESSAGE_DIRECTIONS as readonly string[]).includes(value)
  )
}

/**
 * Delivery lifecycle. `received` is the only inbound status; the rest track
 * an outbound send. `bounced`/`failed` are terminal and carry `last_error`.
 */
export const EMAIL_MESSAGE_STATUSES = [
  "queued",
  "sent",
  "delivered",
  "bounced",
  "failed",
  "received",
] as const

export type EmailMessageStatus = (typeof EMAIL_MESSAGE_STATUSES)[number]

export function isEmailMessageStatus(value: unknown): value is EmailMessageStatus {
  return typeof value === "string" && (EMAIL_MESSAGE_STATUSES as readonly string[]).includes(value)
}

export const EMAIL_PARTICIPANT_ROLES = ["from", "to", "cc", "bcc", "reply_to"] as const

export type EmailParticipantRole = (typeof EMAIL_PARTICIPANT_ROLES)[number]

export function isEmailParticipantRole(value: unknown): value is EmailParticipantRole {
  return typeof value === "string" && (EMAIL_PARTICIPANT_ROLES as readonly string[]).includes(value)
}

export const EMAIL_THREAD_STATUSES = ["open", "archived"] as const

export type EmailThreadStatus = (typeof EMAIL_THREAD_STATUSES)[number]

export function isEmailThreadStatus(value: unknown): value is EmailThreadStatus {
  return typeof value === "string" && (EMAIL_THREAD_STATUSES as readonly string[]).includes(value)
}

/**
 * One conversation. Created by the first message that cannot be attached to
 * an existing thread; `normalized_subject` + `participant_key` are frozen
 * from that first message so the subject fallback stays stable as replies
 * add recipients.
 */
export const emailThreads = pgTable(
  "email_threads",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    subject: text("subject"),
    /** `Re:`/`Fwd:` prefixes stripped, whitespace collapsed, lower-cased. */
    normalizedSubject: text("normalized_subject").notNull().default(""),
    /** sha256 hex of the sorted, de-duplicated address set. */
    participantKey: varchar("participant_key", { length: 64 }).notNull().default(""),
    status: varchar("status", { length: 32 }).notNull().default("open"),
    messageCount: integer("message_count").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /** Cross-module links (plain uuid, no FK — see header comment). */
    personId: uuid("person_id"),
    companyId: uuid("company_id"),
    dealId: uuid("deal_id"),
  },
  (t) => [
    index("email_threads_workspace_idx").on(t.workspaceId),
    index("email_threads_recent_idx").on(t.workspaceId, t.lastMessageAt),
    index("email_threads_status_idx").on(t.workspaceId, t.status),
    // The subject fallback lookup: exactly this three-column prefix.
    index("email_threads_match_idx").on(t.workspaceId, t.normalizedSubject, t.participantKey),
    index("email_threads_person_idx").on(t.personId),
    index("email_threads_company_idx").on(t.companyId),
    index("email_threads_deal_idx").on(t.dealId),
    check("email_threads_status_chk", sql`${t.status} IN ('open', 'archived')`),
  ],
)

export type EmailThread = typeof emailThreads.$inferSelect
export type NewEmailThread = typeof emailThreads.$inferInsert

/**
 * One email. `body_html` is stored already sanitised (see
 * `packages/crm/src/email/sanitize.ts`); `body_text` is the rendering the
 * API and the web UI actually serve.
 */
export const emailMessages = pgTable(
  "email_messages",
  {
    ...baseColumns,
    ...workspaceColumn,
    threadId: uuid("thread_id")
      .notNull()
      .references(() => emailThreads.id, { onDelete: "cascade" }),
    direction: varchar("direction", { length: 16 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("queued"),
    /** RFC 5322 Message-ID, normalised. Unique per workspace. */
    messageId: varchar("message_id", { length: 998 }),
    inReplyTo: varchar("in_reply_to", { length: 998 }),
    /** RFC 5322 References chain, oldest first, normalised. */
    referenceIds: jsonb("reference_ids").$type<string[]>().notNull().default([]),
    subject: text("subject"),
    fromAddress: varchar("from_address", { length: 320 }),
    fromName: varchar("from_name", { length: 255 }),
    bodyText: text("body_text"),
    /** Sanitised at ingest; never served to a browser in P0. */
    bodyHtml: text("body_html"),
    snippet: varchar("snippet", { length: 280 }),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    /** Which integration carried it (plain uuid, no FK — see header). */
    connectionId: uuid("connection_id"),
    providerId: varchar("provider_id", { length: 64 }),
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    /** Redacted provider failure reason — never a credential. */
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    /** Cross-module links (plain uuid, no FK — see header comment). */
    personId: uuid("person_id"),
    companyId: uuid("company_id"),
    dealId: uuid("deal_id"),
  },
  (t) => [
    index("email_messages_workspace_idx").on(t.workspaceId),
    index("email_messages_thread_idx").on(t.threadId, t.createdAt),
    index("email_messages_status_idx").on(t.workspaceId, t.direction, t.status),
    index("email_messages_provider_idx").on(t.workspaceId, t.providerMessageId),
    index("email_messages_person_idx").on(t.personId),
    index("email_messages_company_idx").on(t.companyId),
    index("email_messages_deal_idx").on(t.dealId),
    // Threading lookup: "which thread owns this Message-ID?".
    index("email_messages_message_id_idx").on(t.workspaceId, t.messageId),
    // Idempotency for webhook re-delivery. NOT filtered on deleted_at: a
    // message that was deleted must not be recreated by a provider retry.
    uniqueIndex("email_messages_message_id_uidx")
      .on(t.workspaceId, t.messageId)
      .where(sql`${t.messageId} IS NOT NULL`),
    check("email_messages_direction_chk", sql`${t.direction} IN ('inbound', 'outbound')`),
    check(
      "email_messages_status_chk",
      sql`${t.status} IN ('queued', 'sent', 'delivered', 'bounced', 'failed', 'received')`,
    ),
  ],
)

export type EmailMessage = typeof emailMessages.$inferSelect
export type NewEmailMessage = typeof emailMessages.$inferInsert

/**
 * One (message, role, address) triple. `thread_id` is denormalised so
 * "every address that has ever appeared in this thread" is a single indexed
 * read. `person_id` is the resolved CRM contact, when one matches.
 */
export const emailParticipants = pgTable(
  "email_participants",
  {
    ...baseColumns,
    ...workspaceColumn,
    emailMessageId: uuid("email_message_id")
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => emailThreads.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).notNull(),
    address: varchar("address", { length: 320 }).notNull(),
    displayName: varchar("display_name", { length: 255 }),
    /** Cross-module link (plain uuid, no FK — see header comment). */
    personId: uuid("person_id"),
  },
  (t) => [
    index("email_participants_message_idx").on(t.emailMessageId),
    index("email_participants_thread_idx").on(t.threadId),
    index("email_participants_address_idx").on(t.workspaceId, t.address),
    index("email_participants_person_idx").on(t.personId),
    uniqueIndex("email_participants_unique_uidx")
      .on(t.emailMessageId, t.role, t.address)
      .where(sql`${t.deletedAt} IS NULL`),
    check("email_participants_role_chk", sql`${t.role} IN ('from', 'to', 'cc', 'bcc', 'reply_to')`),
  ],
)

export type EmailParticipant = typeof emailParticipants.$inferSelect
export type NewEmailParticipant = typeof emailParticipants.$inferInsert

/**
 * Attachment METADATA only. `storage_key` addresses the object in S3/MinIO
 * (`@yourcrm/storage`); there is deliberately no bytea/base64 column for a
 * payload to land in.
 */
export const emailAttachments = pgTable(
  "email_attachments",
  {
    ...baseColumns,
    ...workspaceColumn,
    emailMessageId: uuid("email_message_id")
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 128 }),
    sizeBytes: integer("size_bytes").notNull().default(0),
    /** Object key in @yourcrm/storage. Null until the bytes are fetched. */
    storageKey: text("storage_key"),
    /** RFC 2392 Content-ID for inline images. */
    contentId: varchar("content_id", { length: 255 }),
    isInline: boolean("is_inline").notNull().default(false),
  },
  (t) => [
    index("email_attachments_message_idx").on(t.emailMessageId),
    index("email_attachments_workspace_idx").on(t.workspaceId),
  ],
)

export type EmailAttachment = typeof emailAttachments.$inferSelect
export type NewEmailAttachment = typeof emailAttachments.$inferInsert
