import { isNull, sql } from "drizzle-orm"
import {
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
import { baseColumns, workspaceColumn } from "./base"

/**
 * WhatsApp module tables (spec 16-whatsapp, P0).
 *
 * - `whatsapp_conversations`: one row per (connection, contact phone number).
 *   `connection_id` is a PLAIN uuid with NO foreign key — the
 *   `integration_connections` table belongs to the integrations module (same
 *   rule as `people.company_id`, 0010_people.sql). `person_id`/`company_id`
 *   are likewise plain uuid columns with no FK.
 * - `whatsapp_messages`: one row per inbound/outbound message. `conversation_id`
 *   IS a real FK — `whatsapp_conversations` is owned by this same migration.
 *   `template_id` is also a real FK to `whatsapp_templates` (same migration).
 * - `whatsapp_templates`: approved/pending message templates used to open or
 *   re-open a conversation outside the 24h session window.
 *
 * The 24-hour WhatsApp Business session window is enforced in the domain
 * service (`packages/crm/src/whatsapp/session-window.ts`) against
 * `whatsapp_conversations.last_inbound_at` — there is no DB constraint for
 * it, since "is a template" is a service-level decision, not a data shape.
 *
 * Media: bytes live in `@yourcrm/storage` (S3/MinIO); only the storage key
 * and content metadata are stored here.
 */

export const WHATSAPP_CONVERSATION_STATUSES = ["open", "archived"] as const

export type WhatsAppConversationStatus = (typeof WHATSAPP_CONVERSATION_STATUSES)[number]

export function isWhatsAppConversationStatus(value: unknown): value is WhatsAppConversationStatus {
  return (
    typeof value === "string" &&
    (WHATSAPP_CONVERSATION_STATUSES as readonly string[]).includes(value)
  )
}

export const WHATSAPP_MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const

export type WhatsAppMessageDirection = (typeof WHATSAPP_MESSAGE_DIRECTIONS)[number]

export function isWhatsAppMessageDirection(value: unknown): value is WhatsAppMessageDirection {
  return (
    typeof value === "string" && (WHATSAPP_MESSAGE_DIRECTIONS as readonly string[]).includes(value)
  )
}

export const WHATSAPP_MESSAGE_KINDS = [
  "text",
  "template",
  "image",
  "document",
  "audio",
  "video",
  "interactive",
  "unknown",
] as const

export type WhatsAppMessageKind = (typeof WHATSAPP_MESSAGE_KINDS)[number]

export function isWhatsAppMessageKind(value: unknown): value is WhatsAppMessageKind {
  return typeof value === "string" && (WHATSAPP_MESSAGE_KINDS as readonly string[]).includes(value)
}

/**
 * `queued -> sent -> delivered -> read`, with `failed` reachable from
 * `queued`/`sent`. Rank order used by the repository to make status webhooks
 * idempotent and out-of-order safe — see `whatsapp-repository.ts`.
 */
export const WHATSAPP_MESSAGE_STATUSES = ["queued", "sent", "failed", "delivered", "read"] as const

export type WhatsAppMessageStatus = (typeof WHATSAPP_MESSAGE_STATUSES)[number]

export function isWhatsAppMessageStatus(value: unknown): value is WhatsAppMessageStatus {
  return (
    typeof value === "string" && (WHATSAPP_MESSAGE_STATUSES as readonly string[]).includes(value)
  )
}

export const WHATSAPP_TEMPLATE_STATUSES = ["pending", "approved", "rejected"] as const

export type WhatsAppTemplateStatus = (typeof WHATSAPP_TEMPLATE_STATUSES)[number]

export function isWhatsAppTemplateStatus(value: unknown): value is WhatsAppTemplateStatus {
  return (
    typeof value === "string" && (WHATSAPP_TEMPLATE_STATUSES as readonly string[]).includes(value)
  )
}

export const whatsappConversations = pgTable(
  "whatsapp_conversations",
  {
    ...baseColumns,
    ...workspaceColumn,
    /** `integration_connections.id` — plain uuid, no FK (different module). */
    connectionId: uuid("connection_id").notNull(),
    /** E.164 normalised on write — see `phone.ts`. */
    contactPhone: varchar("contact_phone", { length: 32 }).notNull(),
    personId: uuid("person_id"),
    companyId: uuid("company_id"),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    /** Drives the 24h session window (spec: only a template outside it). */
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastMessagePreview: varchar("last_message_preview", { length: 255 }),
    unreadCount: integer("unread_count").notNull().default(0),
  },
  (t) => [
    index("whatsapp_conversations_workspace_idx").on(t.workspaceId),
    index("whatsapp_conversations_person_idx").on(t.personId),
    index("whatsapp_conversations_company_idx").on(t.companyId),
    index("whatsapp_conversations_last_message_idx").on(t.workspaceId, t.lastMessageAt),
    // One open conversation per (connection, contact phone number).
    uniqueIndex("whatsapp_conversations_connection_phone_uidx")
      .on(t.workspaceId, t.connectionId, t.contactPhone)
      .where(isNull(t.deletedAt)),
  ],
)

export type WhatsAppConversationRow = typeof whatsappConversations.$inferSelect
export type NewWhatsAppConversationRow = typeof whatsappConversations.$inferInsert

export const whatsappTemplates = pgTable(
  "whatsapp_templates",
  {
    ...baseColumns,
    ...workspaceColumn,
    /** `integration_connections.id` — plain uuid, no FK (different module). */
    connectionId: uuid("connection_id").notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    language: varchar("language", { length: 16 }).notNull().default("en_US"),
    category: varchar("category", { length: 32 }),
    status: varchar("status", { length: 16 }).notNull().default("approved"),
    bodyText: text("body_text").notNull(),
    variableCount: integer("variable_count").notNull().default(0),
  },
  (t) => [
    index("whatsapp_templates_workspace_idx").on(t.workspaceId),
    index("whatsapp_templates_connection_idx").on(t.workspaceId, t.connectionId),
    uniqueIndex("whatsapp_templates_name_uidx")
      .on(t.workspaceId, t.connectionId, t.name, t.language)
      .where(isNull(t.deletedAt)),
  ],
)

export type WhatsAppTemplateRow = typeof whatsappTemplates.$inferSelect
export type NewWhatsAppTemplateRow = typeof whatsappTemplates.$inferInsert

export const whatsappMessages = pgTable(
  "whatsapp_messages",
  {
    ...baseColumns,
    ...workspaceColumn,
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => whatsappConversations.id, { onDelete: "cascade" }),
    direction: varchar("direction", { length: 16 }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull().default("text"),
    body: text("body"),
    templateId: uuid("template_id").references(() => whatsappTemplates.id, {
      onDelete: "set null",
    }),
    templateVariables: jsonb("template_variables").$type<string[]>(),
    mediaStorageKey: varchar("media_storage_key", { length: 512 }),
    mediaContentType: varchar("media_content_type", { length: 128 }),
    mediaFileName: varchar("media_file_name", { length: 255 }),
    mediaSizeBytes: integer("media_size_bytes"),
    /** Provider-assigned message id (Meta `wamid…`). Idempotency key for status webhooks. */
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    status: varchar("status", { length: 16 }).notNull().default("queued"),
    statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    /** Redacted failure reason — never a credential (see `redactIntegrationSecrets`). */
    error: text("error"),
  },
  (t) => [
    index("whatsapp_messages_workspace_idx").on(t.workspaceId),
    index("whatsapp_messages_conversation_idx").on(t.conversationId, t.createdAt),
    // Idempotency key for both inbound dedup and status-update lookups.
    uniqueIndex("whatsapp_messages_provider_message_uidx")
      .on(t.workspaceId, t.providerMessageId)
      .where(sql`${t.providerMessageId} is not null and ${t.deletedAt} is null`),
  ],
)

export type WhatsAppMessageRow = typeof whatsappMessages.$inferSelect
export type NewWhatsAppMessageRow = typeof whatsappMessages.$inferInsert
