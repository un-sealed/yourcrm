/**
 * Cross-module service ports for `@yourcrm/crm`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `packages/crm/src/index.ts` is a *generated* barrel (`scripts/gen-barrels.ts`)
 * that does `export * from "./<module>"` for every CRM module. Each module was
 * written against the `people` reference implementation, so all twelve declared
 * their own identical `AuditWriter` / `EventEmitter` in their local `types.ts`.
 * Twelve same-named declarations re-exported through one barrel is ambiguous,
 * and TypeScript rejects it with TS2308.
 *
 * So the ports that are genuinely shared live here, once, and every module's
 * `types.ts` imports them from `../ports`. Anything that is actually
 * module-specific (stores, records, queries, and each module's own
 * `<Module>AuditInput`) stays in that module's `types.ts`.
 *
 * These stay structural on purpose: `@yourcrm/crm` has no database dependency,
 * so services never import `@yourcrm/database`. The API layer adapts the
 * drizzle repositories and `writeAudit` to these shapes, and the hermetic test
 * fakes satisfy them the same way.
 */

/**
 * Audit sink port, generic over each module's own audit-input shape.
 *
 * The input type is deliberately a parameter rather than one shared union:
 * every module keeps its own `<Module>AuditInput` (a structural mirror of
 * `WriteAuditInput`) so a module can tighten its audit payload without
 * touching the other eleven.
 *
 * @example
 * ```ts
 * import type { AuditWriter } from "../ports"
 * export type PeopleServiceDeps = { audit: AuditWriter<PersonAuditInput> }
 * ```
 */
export type AuditWriter<TInput> = (input: TInput) => Promise<unknown>

/**
 * Domain-event sink port.
 *
 * Structurally identical in all twelve modules, so it takes no type parameter.
 * Mirrors the `@yourcrm/events` bus without importing it, keeping the service
 * layer injectable and test-fakeable.
 */
export type EventEmitter = {
  emit(event: {
    event: string
    workspaceId: string
    actorId?: string
    entityType?: string
    entityId?: string
    before?: unknown
    after?: unknown
    correlationId?: string
  }): Promise<void>
}
