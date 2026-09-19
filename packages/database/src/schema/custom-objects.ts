import { isNull } from "drizzle-orm"
import { index, jsonb, pgTable, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core"
import { baseColumns, ownerColumn, workspaceColumn } from "./base"

/**
 * Custom objects (spec 33-custom-objects-fields, P0).
 *
 * METADATA-DRIVEN, NOT DDL-DRIVEN
 * -------------------------------
 * A user-defined object type is a *row* in `custom_object_definitions`, and
 * its records are rows in `custom_object_records` whose values live in one
 * `jsonb` column. Nothing here ever issues `CREATE TABLE` / `ALTER TABLE`
 * in response to user input: runtime DDL would be an injection surface, it
 * cannot be reviewed or rolled back like a migration, and it multiplies the
 * schema per tenant. The price is that every write must be validated in
 * application code against the field definitions — see
 * `buildCustomObjectRecordSchema` in `@yourcrm/crm/src/custom-objects`.
 *
 * FIELDS REUSE THE EXISTING CATALOG
 * ---------------------------------
 * There is no second field table. Fields of a custom object are ordinary
 * rows in `custom_field_definitions` (0003_shared_tables) with
 * `object_type` set to the object's **slug**, exactly as a field on a
 * built-in object uses `object_type = 'person'`. That is why the slug is
 * immutable and why built-in object names are reserved slugs: the slug is
 * the join key, and the existing
 * `(workspace_id, object_type, key)` unique index then gives per-object
 * field-key uniqueness for custom objects for free.
 */

/**
 * One admin-defined object type per row, scoped to a workspace.
 *
 * `slug` is the stable programmatic name. It appears in API paths
 * (`/api/v1/custom-objects/:slug/...`) and joins to
 * `custom_field_definitions.object_type`, so it is validated against a
 * strict allowlist pattern, checked against a reserved-word list and never
 * changed after creation. Renaming an object changes `name`/`plural_name`.
 */
export const customObjectDefinitions = pgTable(
  "custom_object_definitions",
  {
    ...baseColumns,
    ...workspaceColumn,
    slug: varchar("slug", { length: 64 }).notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    pluralName: varchar("plural_name", { length: 128 }).notNull(),
    icon: varchar("icon", { length: 64 }),
    description: text("description"),
  },
  (t) => [
    index("custom_object_definitions_workspace_idx").on(t.workspaceId),
    uniqueIndex("custom_object_definitions_workspace_slug_uidx")
      .on(t.workspaceId, t.slug)
      .where(isNull(t.deletedAt)),
  ],
)

export type CustomObjectDefinition = typeof customObjectDefinitions.$inferSelect
export type NewCustomObjectDefinition = typeof customObjectDefinitions.$inferInsert

/**
 * Stored record payload: field key -> value. Keys are
 * `custom_field_definitions.key` values (immutable, allowlist-validated
 * snake_case), never raw user strings. Values stay `unknown` on purpose —
 * the only way to read one safely is through the zod schema built from the
 * live field definitions.
 */
export type CustomObjectFieldValues = Record<string, unknown>

/**
 * One instance of a custom object.
 *
 * `object_id` IS a foreign key: same module, same migration file.
 * `display_name` is denormalized from the object's first text field so list
 * views and headers do not have to crack the jsonb, and so ordering and
 * search can use a btree index.
 */
export const customObjectRecords = pgTable(
  "custom_object_records",
  {
    ...baseColumns,
    ...workspaceColumn,
    ...ownerColumn,
    objectId: uuid("object_id")
      .notNull()
      .references(() => customObjectDefinitions.id, { onDelete: "cascade" }),
    displayName: varchar("display_name", { length: 255 }).notNull().default("Untitled"),
    // NOT called "values": VALUES is a reserved word in Postgres and the
    // column would need quoting in every hand-written statement.
    fieldValues: jsonb("field_values").$type<CustomObjectFieldValues>().notNull().default({}),
  },
  (t) => [
    index("custom_object_records_object_idx").on(t.workspaceId, t.objectId),
    index("custom_object_records_owner_idx").on(t.ownerId),
    index("custom_object_records_display_name_idx").on(t.workspaceId, t.displayName),
    index("custom_object_records_field_values_idx").using("gin", t.fieldValues),
  ],
)

export type CustomObjectRecord = typeof customObjectRecords.$inferSelect
export type NewCustomObjectRecord = typeof customObjectRecords.$inferInsert
