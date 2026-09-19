import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Calling module tables (spec 17-calling, P0).
 *
 * - `calls`: one row per call attempt/leg — click-to-call placed through a
 *   provider OR a rep's manual log of a call made outside the system.
 *   `person_id` / `company_id` / `deal_id` / `connection_id` are PLAIN uuid
 *   columns with NO foreign key: those tables belong to other modules (same
 *   rule as `people.company_id`, 0010_people.sql).
 * - `call_recordings`: metadata only (url/duration/size). Bytes live in
 *   S3/MinIO via `@yourcrm/storage`; this table never stores bytes.
 *   `call_id` IS a real FK — `calls` is defined in this same migration.
 *
 * `recording_consent` on `calls` defaults to false on purpose (P0 hard
 * rule): consent must be an explicit, affirmative action, never assumed.
 */

export const CALL_DIRECTIONS = ["inbound", "outbound"] as const

export type CallDirection = (typeof CALL_DIRECTIONS)[number]

export function isCallDirection(value: unknown): value is CallDirection {
  return typeof value === "string" && (CALL_DIRECTIONS as readonly string[]).includes(value)
}

/**
 * Lifecycle status. Order matters for out-of-order webhook handling — see
 * `CALL_STATUS_RANK` in `../../crm/src/calling/status.ts` (the crm package
 * owns the transition-guard logic; this file only owns storage).
 */
export const CALL_STATUSES = [
  "queued",
  "ringing",
  "in_progress",
  "completed",
  "failed",
  "no_answer",
  "busy",
] as const

export type CallStatus = (typeof CALL_STATUSES)[number]

export function isCallStatus(value: unknown): value is CallStatus {
  return typeof value === "string" && (CALL_STATUSES as readonly string[]).includes(value)
}

/** Terminal statuses are sticky: once reached, no further transition applies. */
export const TERMINAL_CALL_STATUSES: readonly CallStatus[] = [
  "completed",
  "failed",
  "no_answer",
  "busy",
]

export const CALL_SOURCES = ["manual", "provider"] as const

export type CallSource = (typeof CALL_SOURCES)[number]

export function isCallSource(value: unknown): value is CallSource {
  return typeof value === "string" && (CALL_SOURCES as readonly string[]).includes(value)
}

export const calls = pgTable(
  "calls",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    direction: varchar("direction", { length: 16 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("queued"),
    /** `manual` — a rep logged a call made outside the system. `provider` — placed via click-to-call. */
    source: varchar("source", { length: 16 }).notNull().default("manual"),
    /** E.164, normalised on write (`../../crm/src/calling/phone.ts`). */
    fromNumber: varchar("from_number", { length: 32 }).notNull(),
    toNumber: varchar("to_number", { length: 32 }).notNull(),
    personId: uuid("person_id"),
    companyId: uuid("company_id"),
    dealId: uuid("deal_id"),
    /** `integration_connections.id` — plain uuid, that table is owned by the integrations module. */
    connectionId: uuid("connection_id"),
    /** Snapshot of the provider machine id used, even if the connection is later removed. */
    providerId: varchar("provider_id", { length: 64 }),
    /** Provider-side call sid — how an inbound status webhook finds this row. */
    providerCallId: varchar("provider_call_id", { length: 255 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    disposition: varchar("disposition", { length: 64 }),
    notes: text("notes"),
    /** Explicit, never defaults to true — consent varies by jurisdiction. */
    recordingConsent: boolean("recording_consent").notNull().default(false),
    /** Redacted provider failure reason, when placing/advancing the call failed. */
    errorMessage: text("error_message"),
  },
  (t) => [
    index("calls_workspace_idx").on(t.workspaceId),
    index("calls_status_idx").on(t.workspaceId, t.status),
    index("calls_direction_idx").on(t.workspaceId, t.direction),
    index("calls_owner_idx").on(t.workspaceId, t.ownerId),
    index("calls_person_idx").on(t.workspaceId, t.personId),
    index("calls_company_idx").on(t.workspaceId, t.companyId),
    index("calls_deal_idx").on(t.workspaceId, t.dealId),
    index("calls_connection_idx").on(t.workspaceId, t.connectionId),
    index("calls_created_idx").on(t.workspaceId, t.createdAt),
    // Match an inbound status webhook to its call. Partial: manual logs never
    // carry a provider_call_id.
    uniqueIndex("calls_provider_call_uidx")
      .on(t.workspaceId, t.providerId, t.providerCallId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.providerCallId} IS NOT NULL`),
  ],
)

export type CallRow = typeof calls.$inferSelect
export type NewCallRow = typeof calls.$inferInsert

export const callRecordings = pgTable(
  "call_recordings",
  {
    ...baseColumns,
    ...workspaceColumn,
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    /** Storage key (`@yourcrm/storage`) or provider-hosted URL. Never bytes. */
    url: text("url").notNull(),
    durationSeconds: integer("duration_seconds"),
    sizeBytes: integer("size_bytes"),
  },
  (t) => [
    index("call_recordings_workspace_idx").on(t.workspaceId),
    index("call_recordings_call_idx").on(t.callId),
  ],
)

export type CallRecordingRow = typeof callRecordings.$inferSelect
export type NewCallRecordingRow = typeof callRecordings.$inferInsert
