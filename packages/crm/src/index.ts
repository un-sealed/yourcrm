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
export * from "./activities"
export * from "./ai-agents"
export * from "./ai-assistant"
export * from "./ai-governance"
export * from "./api-webhooks"
export * from "./automation"
export * from "./booking-links"
export * from "./calendar"
export * from "./calling"
export * from "./companies"
export * from "./conversation-intelligence"
export * from "./custom-objects"
export * from "./customer-success"
export * from "./dashboards"
export * from "./deals"
export * from "./email"
export * from "./files"
export * from "./forms"
export * from "./import-export"
export * from "./integrations"
export * from "./invoices"
export * from "./knowledge-base"
export * from "./leads"
export * from "./marketing"
export * from "./marketplace"
export * from "./notifications"
export * from "./onboarding"
export * from "./people"
export * from "./pipelines"
export * from "./portal"
export * from "./ports"
export * from "./products"
export * from "./quotes"
export * from "./reports"
export * from "./search"
export * from "./sequences"
export * from "./settings"
export * from "./support"
export * from "./tasks"
export * from "./unified-inbox"
export * from "./whatsapp"
