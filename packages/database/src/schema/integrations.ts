import { isNull } from "drizzle-orm"
import {
  index,
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
 * Integrations framework tables (spec 31-integrations, P0).
 *
 * Three tables, one responsibility each:
 *
 * - `integration_connections` — one row per installed integration per
 *   workspace: which provider, what it is called, whether it is healthy.
 *   Never holds a secret.
 * - `integration_credentials` — the sealed secrets. Ciphertext, IV and GCM
 *   auth tag only; there is deliberately NO plaintext column, so no query,
 *   export or log can leak one. `hint` is the masked display value
 *   (`sk-…4f2a`) and is the ONLY credential-derived value any API returns.
 * - `integration_webhook_events` — inbound deliveries, unique on
 *   (connection, provider_event_id): that index *is* the idempotency
 *   guarantee, so a provider retrying a delivery cannot double-process it.
 *
 * `workspace_id` and `created_by`/`updated_by` are PLAIN uuid columns with no
 * foreign key, following 0010_people.sql. `connection_id` IS a real FK: both
 * tables live in this module's own migration (0180_integrations.sql).
 */

export const INTEGRATION_CONNECTION_STATUSES = ["connected", "disconnected", "error"] as const

export type IntegrationConnectionStatusValue = (typeof INTEGRATION_CONNECTION_STATUSES)[number]

export function isIntegrationConnectionStatusValue(
  value: unknown,
): value is IntegrationConnectionStatusValue {
  return (
    typeof value === "string" &&
    (INTEGRATION_CONNECTION_STATUSES as readonly string[]).includes(value)
  )
}

export const INTEGRATION_CREDENTIAL_KINDS = ["api_key", "webhook_secret", "oauth_tokens"] as const

export type IntegrationCredentialKindValue = (typeof INTEGRATION_CREDENTIAL_KINDS)[number]

export function isIntegrationCredentialKindValue(
  value: unknown,
): value is IntegrationCredentialKindValue {
  return (
    typeof value === "string" && (INTEGRATION_CREDENTIAL_KINDS as readonly string[]).includes(value)
  )
}

export const INTEGRATION_WEBHOOK_EVENT_STATUSES = [
  "received",
  "processed",
  "ignored",
  "failed",
] as const

export type IntegrationWebhookEventStatusValue = (typeof INTEGRATION_WEBHOOK_EVENT_STATUSES)[number]

export const integrationConnections = pgTable(
  "integration_connections",
  {
    ...baseColumns,
    ...workspaceColumn,
    providerId: varchar("provider_id", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("disconnected"),
    authKind: varchar("auth_kind", { length: 32 }).notNull().default("api_key"),
    /** Provider-side account id (mailbox, WABA id, phone number, …). */
    externalAccountId: varchar("external_account_id", { length: 255 }),
    /** Non-secret provider settings, validated by the provider's zod schema. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true }),
    lastHealthStatus: varchar("last_health_status", { length: 32 }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  },
  (t) => [
    index("integration_connections_workspace_idx").on(t.workspaceId),
    index("integration_connections_provider_idx").on(t.workspaceId, t.providerId),
    index("integration_connections_status_idx").on(t.workspaceId, t.status),
    // One connection per (workspace, provider, provider-side account). NULL
    // external ids stay distinct in Postgres, so a provider that does not
    // report an account id can still be installed more than once.
    uniqueIndex("integration_connections_account_uidx")
      .on(t.workspaceId, t.providerId, t.externalAccountId)
      .where(isNull(t.deletedAt)),
  ],
)

export type IntegrationConnectionRow = typeof integrationConnections.$inferSelect
export type NewIntegrationConnectionRow = typeof integrationConnections.$inferInsert

export const integrationCredentials = pgTable(
  "integration_credentials",
  {
    ...baseColumns,
    ...workspaceColumn,
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 32 }).notNull(),
    algorithm: varchar("algorithm", { length: 32 }).notNull().default("aes-256-gcm"),
    /** Key-rotation extension point: re-seal rows with a newer version. */
    keyVersion: varchar("key_version", { length: 16 }).notNull().default("v1"),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    /** Masked display value, e.g. `sk-…4f2a`. Safe to return from the API. */
    hint: varchar("hint", { length: 64 }),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    /** Reserved for the OAuth extension point (refresh-ahead jobs). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    index("integration_credentials_workspace_idx").on(t.workspaceId),
    uniqueIndex("integration_credentials_slot_uidx")
      .on(t.connectionId, t.kind)
      .where(isNull(t.deletedAt)),
  ],
)

export type IntegrationCredentialRow = typeof integrationCredentials.$inferSelect
export type NewIntegrationCredentialRow = typeof integrationCredentials.$inferInsert

export const integrationWebhookEvents = pgTable(
  "integration_webhook_events",
  {
    ...baseColumns,
    ...workspaceColumn,
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    providerId: varchar("provider_id", { length: 64 }).notNull(),
    providerEventId: varchar("provider_event_id", { length: 255 }).notNull(),
    eventType: varchar("event_type", { length: 128 }),
    status: varchar("status", { length: 32 }).notNull().default("received"),
    payload: jsonb("payload").$type<unknown>(),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("integration_webhook_events_workspace_idx").on(t.workspaceId),
    index("integration_webhook_events_connection_idx").on(t.connectionId, t.receivedAt),
    index("integration_webhook_events_status_idx").on(t.workspaceId, t.status),
    // NOT filtered on deleted_at: idempotency must hold for the lifetime of
    // the connection, including for rows an operator soft-deleted.
    uniqueIndex("integration_webhook_events_idempotency_uidx").on(
      t.connectionId,
      t.providerEventId,
    ),
  ],
)

export type IntegrationWebhookEventRow = typeof integrationWebhookEvents.$inferSelect
export type NewIntegrationWebhookEventRow = typeof integrationWebhookEvents.$inferInsert
