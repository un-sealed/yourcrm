import type { AiReportQueryPort } from "@yourcrm/crm/src/ai-assistant"
import type { AiActionProposalPort } from "@yourcrm/crm/src/ai-governance"
import type { AuditWriter } from "@yourcrm/crm/src/ports"
import type { SearchHitListResult } from "@yourcrm/crm/src/search"
import type { ServiceContext } from "@yourcrm/validation"

/**
 * The CRM surface the MCP toolset is allowed to reach (spec 39-mcp, P0).
 *
 * ## Why this file is a list of ports and not a list of repositories
 *
 * `AGENTS.md` and `docs/architecture.md` both say it outright: *MCP tools
 * consume domain services, never tables.* So `apps/mcp` has no dependency
 * on the database package — no repository, no ORM schema, no SQL — and
 * `boundary.test.ts` asserts that from the source text. Everything the
 * tools can do arrives through the three narrow ports below, each of which
 * is satisfied by a real domain service:
 *
 *  - {@link McpReportsPort} — the reports query engine, handed to the
 *    ASSISTANT'S OWN tool set (`@yourcrm/crm/src/ai-assistant`). MCP read
 *    tools do not define a second query path; they call the very tools the
 *    Ask-Your-CRM assistant calls, which compile an allowlisted, row-scoped
 *    report definition. There is no code path from an MCP argument to SQL.
 *  - {@link McpSearchPort} — `createSearchService(...)`, which filters hits
 *    by the object types and records the caller may read.
 *  - {@link McpGovernancePort} — `AiActionProposalPort.requestAction`. This
 *    is the ONLY write-shaped port here, and it cannot mutate a record: it
 *    queues an `ai_action_request` for a human. The apply path is not
 *    reachable from this process (see `tools.ts`).
 *
 * ## Blocker: nothing wires a production runtime yet
 *
 * Building the real ports means `createReportsRepository()`,
 * `createSearchService({ store: searchRepository })` and
 * `createAiGovernanceService({...})` — all of which need the database
 * package, which `apps/mcp` must not (and does not) declare. Adding that
 * dependency would also make it possible to reach a table from a tool,
 * which is the thing this module exists to prevent.
 *
 * So the composition root is left to the integrator: `createMcpServer()`
 * takes the runtime. Until one is injected, production gets
 * {@link createUnconfiguredMcpRuntime}, which lists the catalogue happily
 * and refuses every call — the same shape as the assistant's
 * `AI_PROVIDER_NOT_CONFIGURED` -> 503. Outside production the entrypoint
 * uses the fixture runtime in `dev-runtime.ts` so the server is drivable by
 * a real MCP client today.
 */

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type McpAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

/**
 * The reports query engine, exactly as the assistant's tools want it.
 * `ReportsStore` from `@yourcrm/crm/src/reports` satisfies it unchanged.
 */
export type McpReportsPort = AiReportQueryPort

/** The global search domain service. `createSearchService(...)` satisfies it. */
export type McpSearchPort = {
  search(ctx: ServiceContext, query: unknown): Promise<SearchHitListResult>
}

/**
 * The propose-only half of AI governance. Deliberately this narrow type and
 * not `AiGovernanceService`: `requestAction` is the only method on it, so
 * there is no `approve` and no `apply` for an MCP tool to call, by
 * construction rather than by discipline.
 */
export type McpGovernancePort = AiActionProposalPort

export type McpRuntime = {
  reports: McpReportsPort
  search: McpSearchPort
  governance: McpGovernancePort
  /** Every tool call writes one row through here. See `tools.ts`. */
  audit: AuditWriter<McpAuditInput>
}

/** Raised by the placeholder runtime — never leaks configuration detail. */
export class McpRuntimeNotConfiguredError extends Error {
  readonly code = "MCP_RUNTIME_NOT_CONFIGURED"
  constructor() {
    super(
      "this MCP server has no CRM runtime wired — the host application must pass one to createMcpServer()",
    )
    this.name = "McpRuntimeNotConfiguredError"
  }
}

function refuse(): never {
  throw new McpRuntimeNotConfiguredError()
}

/**
 * A runtime that answers `tools/list` (the catalogue is static) and refuses
 * every `tools/call`. The safe default: a server with no CRM behind it must
 * fail loudly, not silently return empty results that read as "no records".
 */
export function createUnconfiguredMcpRuntime(): McpRuntime {
  return {
    reports: {
      describeObjects: () => refuse(),
      execute: () => refuse(),
    },
    search: { search: () => refuse() },
    governance: { requestAction: () => refuse() },
    audit: () => refuse(),
  }
}
