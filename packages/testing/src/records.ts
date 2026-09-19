import type { BaseRecord } from "@yourcrm/validation"
import { nextId } from "./time"

/**
 * Base-record fixture covering the shared `BaseRecord` contract from
 * `@yourcrm/validation` (id, workspaceId, timestamps, actors, deletedAt).
 * Module agents extend it instead of restating it:
 *
 * ```ts
 * const person = { ...makeBaseRecord(), firstName: "Ada", lastName: "Lovelace" }
 * ```
 *
 * Timestamps read the `freezeTime()` clock when frozen.
 */
export function makeBaseRecord(overrides: Partial<BaseRecord> = {}): BaseRecord {
  const now = new Date(Date.now()).toISOString()
  const actor = nextId("user")
  return {
    id: nextId("rec"),
    workspaceId: nextId("ws"),
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
    updatedBy: actor,
    deletedAt: null,
    ...overrides,
  }
}
