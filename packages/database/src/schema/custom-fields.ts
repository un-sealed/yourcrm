import { isNull } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { baseColumns, workspaceColumn } from "./base"

/**
 * Field types owned by this wave. Extended types from spec 03 (currency,
 * phone, file, rating, formula, lookup, rollup, ai-generated, ...) land
 * with the custom-objects module agent, which widens this list — the column
 * stays a plain varchar so no DDL change is needed.
 */
export const CUSTOM_FIELD_TYPES = [
  "text",
  "number",
  "date",
  "select",
  "multiselect",
  "boolean",
  "url",
  "email",
] as const

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number]

export function isCustomFieldType(value: unknown): value is CustomFieldType {
  return typeof value === "string" && (CUSTOM_FIELD_TYPES as readonly string[]).includes(value)
}

/** Option list for select/multiselect fields: plain strings or value/label pairs. */
export type CustomFieldOptions = string[] | { value: string; label?: string }[] | null

/**
 * Value pre-filled when a record is created without this field.
 *
 * Added additively by the custom-objects module (spec 33) — `default` is
 * part of its P0 field-definition scope. Nullable, so every existing row
 * and every existing insert path keeps working unchanged. Defaults are
 * validated against the field's own type like any other value: a bad
 * default must not become a back door for invalid data.
 */
export type CustomFieldDefaultValue = string | number | boolean | string[] | null

/**
 * Admin-defined field on a default or custom object (`object_type` is the
 * object key, e.g. "person", "deal" — or, for a user-defined object, that
 * object's immutable slug from `custom_object_definitions`; see
 * schema/custom-objects.ts). `key` is the stable programmatic name,
 * unique per (workspace, object); `options` holds the allowed choices for
 * select/multiselect; `display_order` drives form/column layout.
 */
export const customFieldDefinitions = pgTable(
  "custom_field_definitions",
  {
    ...baseColumns,
    ...workspaceColumn,
    objectType: varchar("object_type", { length: 64 }).notNull(),
    key: varchar("key", { length: 128 }).notNull(),
    label: varchar("label", { length: 255 }).notNull(),
    fieldType: varchar("field_type", { length: 32 }).notNull(),
    options: jsonb("options").$type<CustomFieldOptions>(),
    /** Added by 0200_custom_objects (additive, nullable). */
    defaultValue: jsonb("default_value").$type<CustomFieldDefaultValue>(),
    required: boolean("required").notNull().default(false),
    displayOrder: integer("display_order").notNull().default(0),
  },
  (t) => [
    index("custom_field_definitions_object_idx").on(t.workspaceId, t.objectType),
    uniqueIndex("custom_field_definitions_workspace_object_key_uidx")
      .on(t.workspaceId, t.objectType, t.key)
      .where(isNull(t.deletedAt)),
  ],
)

export type CustomFieldDefinition = typeof customFieldDefinitions.$inferSelect
export type NewCustomFieldDefinition = typeof customFieldDefinitions.$inferInsert

/**
 * One stored value per (definition, record). The `object_type` lives on the
 * definition row; `record_id` is a PLAIN column (never a foreign key) since
 * target tables are created by later module agents. Values are schemaless
 * JSON; per-type validation happens in the repository before writes.
 */
export const customFieldValues = pgTable(
  "custom_field_values",
  {
    ...baseColumns,
    ...workspaceColumn,
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => customFieldDefinitions.id, { onDelete: "cascade" }),
    recordId: uuid("record_id").notNull(),
    value: jsonb("value"),
  },
  (t) => [
    index("custom_field_values_record_idx").on(t.recordId),
    index("custom_field_values_definition_idx").on(t.definitionId),
    uniqueIndex("custom_field_values_definition_record_uidx")
      .on(t.definitionId, t.recordId)
      .where(isNull(t.deletedAt)),
  ],
)

export type CustomFieldValue = typeof customFieldValues.$inferSelect
export type NewCustomFieldValue = typeof customFieldValues.$inferInsert
