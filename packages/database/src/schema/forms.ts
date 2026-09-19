import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Forms module tables (spec 23-forms, P0).
 *
 * - `forms`: one row per embeddable lead-capture form. `public_id` is the
 *   unguessable share token used by the unauthenticated submission endpoint.
 * - `form_fields`: ordered field definitions belonging to a form
 *   (`form_id` FK is same-module, so the constraint is safe).
 * - `form_submissions`: one row per public submission, values as JSONB keyed
 *   by field id. `lead_id` is a PLAIN uuid column with an index and NO
 *   foreign key — the leads table is owned by another module agent and may
 *   not exist yet; lead creation from a submission is a later pass.
 */

export const FORM_STATUSES = ["draft", "published", "archived"] as const

export type FormStatus = (typeof FORM_STATUSES)[number]

export function isFormStatus(value: unknown): value is FormStatus {
  return typeof value === "string" && (FORM_STATUSES as readonly string[]).includes(value)
}

export const FORM_FIELD_TYPES = [
  "text",
  "email",
  "phone",
  "number",
  "textarea",
  "select",
  "checkbox",
  "date",
] as const

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number]

export function isFormFieldType(value: unknown): value is FormFieldType {
  return typeof value === "string" && (FORM_FIELD_TYPES as readonly string[]).includes(value)
}

export const forms = pgTable(
  "forms",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 32 }).notNull().default("draft"),
    publicId: varchar("public_id", { length: 64 }).notNull(),
    successMessage: text("success_message"),
  },
  (t) => [
    index("forms_workspace_idx").on(t.workspaceId),
    index("forms_status_idx").on(t.workspaceId, t.status),
    index("forms_name_idx").on(t.workspaceId, sql`lower(${t.name})`),
    uniqueIndex("forms_public_id_uidx").on(t.publicId),
  ],
)

export type Form = typeof forms.$inferSelect
export type NewForm = typeof forms.$inferInsert

export const formFields = pgTable(
  "form_fields",
  {
    ...baseColumns,
    ...workspaceColumn,
    formId: uuid("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 255 }).notNull(),
    fieldType: varchar("field_type", { length: 32 }).notNull().default("text"),
    required: boolean("required").notNull().default(false),
    position: integer("position").notNull().default(0),
    placeholder: varchar("placeholder", { length: 255 }),
    options: jsonb("options").$type<string[] | null>(),
    helpText: text("help_text"),
  },
  (t) => [
    index("form_fields_form_idx").on(t.formId),
    index("form_fields_form_position_idx").on(t.formId, t.position),
  ],
)

export type FormField = typeof formFields.$inferSelect
export type NewFormField = typeof formFields.$inferInsert

export const formSubmissions = pgTable(
  "form_submissions",
  {
    ...baseColumns,
    ...workspaceColumn,
    formId: uuid("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "cascade" }),
    values: jsonb("values").$type<Record<string, unknown>>().notNull().default({}),
    submitterEmail: varchar("submitter_email", { length: 320 }),
    // Cross-module reference to the leads table (owned by another agent):
    // plain uuid + index, NO foreign key. Populated by the later
    // lead-creation pass; null until then.
    leadId: uuid("lead_id"),
    ipHash: varchar("ip_hash", { length: 128 }),
    userAgent: text("user_agent"),
  },
  (t) => [
    index("form_submissions_form_idx").on(t.formId),
    index("form_submissions_workspace_idx").on(t.workspaceId),
    index("form_submissions_lead_idx").on(t.leadId),
  ],
)

export type FormSubmission = typeof formSubmissions.$inferSelect
export type NewFormSubmission = typeof formSubmissions.$inferInsert
