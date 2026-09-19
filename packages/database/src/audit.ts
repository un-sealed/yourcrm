import { z } from "zod"
import { auditEvents, type AuditEvent, type NewAuditEvent } from "./schema"
import type { Database } from "./client"

/**
 * Audit source contract (DATA-MODEL-CONTRACTS.md): every important mutation
 * records `source` in `user | automation | ai | integration | mcp`.
 */
export const auditSourceSchema = z.enum(["user", "automation", "ai", "integration", "mcp"])

export type AuditSource = z.infer<typeof auditSourceSchema>

/**
 * Inputs for {@link writeAudit}. Covers the DATA-MODEL-CONTRACTS.md audit
 * contract: workspace, actor, action, object, record id, before/after,
 * correlation id and source.
 */
export type WriteAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: AuditSource
  /** Defaults to `actorId`. Maps to `created_by` on the audit row. */
  createdBy?: string | null
}

/**
 * Minimal database surface `writeAudit` needs. Both the shared `Database`
 * client and a Drizzle transaction handle expose `insert`, so callers inside
 * a transaction pass the `tx` handle here to write the audit row atomically
 * with the mutation:
 *
 * ```ts
 * await db.transaction(async (tx) => {
 *   await tx.update(...).set(...).where(...)
 *   await writeAudit(tx, { workspaceId, actorId, action: "update", object: "deal", ... })
 * })
 * ```
 */
export type AuditDb = Pick<Database, "insert">

/**
 * Append one row to `audit_events`. The table is append-only — this helper
 * only inserts, never updates or deletes.
 */
export async function writeAudit(db: AuditDb, input: WriteAuditInput): Promise<AuditEvent[]> {
  const values: NewAuditEvent = {
    workspaceId: input.workspaceId,
    actorId: input.actorId ?? null,
    action: input.action,
    object: input.object,
    recordId: input.recordId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    correlationId: input.correlationId ?? null,
    source: input.source ?? "user",
    createdBy: input.createdBy ?? input.actorId ?? null,
  }
  return db.insert(auditEvents).values(values).returning()
}
