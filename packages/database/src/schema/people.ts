import { isNull, sql } from "drizzle-orm"
import { boolean, index, pgTable, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * People module tables (spec 06-people, P0).
 *
 * - `people`: one row per contact. `company_id` is a PLAIN uuid column with
 *   an index and NO foreign key — the companies table does not exist yet and
 *   is created by a later module agent (same rule as taggables.record_id).
 * - `person_emails` / `person_phones`: multiple contact methods per person,
 *   exactly one primary each (enforced by the repository, not DDL, so bulk
 *   imports can land before choosing a primary).
 */

export const PEOPLE_STATUSES = ["active", "archived"] as const

export type PersonStatus = (typeof PEOPLE_STATUSES)[number]

export function isPersonStatus(value: unknown): value is PersonStatus {
  return typeof value === "string" && (PEOPLE_STATUSES as readonly string[]).includes(value)
}

export const PERSON_CHANNELS = ["email", "phone", "sms", "whatsapp"] as const

export type PersonChannel = (typeof PERSON_CHANNELS)[number]

export function isPersonChannel(value: unknown): value is PersonChannel {
  return typeof value === "string" && (PERSON_CHANNELS as readonly string[]).includes(value)
}

export const people = pgTable(
  "people",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    firstName: varchar("first_name", { length: 255 }).notNull(),
    lastName: varchar("last_name", { length: 255 }),
    title: varchar("title", { length: 255 }),
    companyId: uuid("company_id"),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    preferredChannel: varchar("preferred_channel", { length: 32 }),
    notes: text("notes"),
  },
  (t) => [
    index("people_workspace_idx").on(t.workspaceId),
    index("people_company_idx").on(t.companyId),
    index("people_status_idx").on(t.workspaceId, t.status),
    index("people_name_idx").on(
      t.workspaceId,
      sql`lower(${t.lastName})`,
      sql`lower(${t.firstName})`,
    ),
  ],
)

export type Person = typeof people.$inferSelect
export type NewPerson = typeof people.$inferInsert

export const personEmails = pgTable(
  "person_emails",
  {
    ...baseColumns,
    ...workspaceColumn,
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 320 }).notNull(),
    label: varchar("label", { length: 64 }),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (t) => [
    index("person_emails_person_idx").on(t.personId),
    uniqueIndex("person_emails_person_email_uidx")
      .on(t.personId, sql`lower(${t.email})`)
      .where(isNull(t.deletedAt)),
  ],
)

export type PersonEmail = typeof personEmails.$inferSelect
export type NewPersonEmail = typeof personEmails.$inferInsert

export const personPhones = pgTable(
  "person_phones",
  {
    ...baseColumns,
    ...workspaceColumn,
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    phone: varchar("phone", { length: 64 }).notNull(),
    label: varchar("label", { length: 64 }),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (t) => [
    index("person_phones_person_idx").on(t.personId),
    uniqueIndex("person_phones_person_phone_uidx")
      .on(t.personId, t.phone)
      .where(isNull(t.deletedAt)),
  ],
)

export type PersonPhone = typeof personPhones.$inferSelect
export type NewPersonPhone = typeof personPhones.$inferInsert
