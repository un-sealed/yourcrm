/**
 * `@yourcrm/crm` — application/domain service boundary for CRM modules.
 *
 * INTENTIONAL PLACEHOLDER. Module agents (people, companies, leads, deals,
 * pipelines, activities, tasks, …) implement their services here behind the
 * layering rule:
 *
 *   Hono route -> validation -> permission check -> service (here)
 *                -> repository (@yourcrm/database) -> PostgreSQL
 *
 * Rules for later agents:
 * - No Hono imports. No UI imports. Services are plain async functions.
 * - Every mutating service emits a domain event (@yourcrm/events) and
 *   writes an audit row.
 * - Every service calls `requirePermission()` first.
 */

export const CRM_BOUNDARY_VERSION = 0 as const

/** Re-exported from @yourcrm/validation so both crm and testing can use it. */
export type { ServiceContext } from "@yourcrm/validation"
