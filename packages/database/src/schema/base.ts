import { timestamp, uuid, varchar } from "drizzle-orm/pg-core"

/**
 * Base column set for every business record (DATA-MODEL-CONTRACTS.md):
 * id, workspace scoping, created/updated (+actor), soft delete.
 * Domain tables spread `baseColumns(workspaceRef)` into their definitions.
 */
export const baseColumns = {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}

export const workspaceColumn = {
  workspaceId: uuid("workspace_id").notNull(),
}

export const ownerColumn = {
  ownerId: uuid("owner_id"),
}

export { timestamp, uuid, varchar }
