import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Unified-inbox service ports (spec 15-unified-inbox, P0).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts `unified-inbox-repository.ts` and `writeAudit` to them, and the
 * hermetic tests satisfy them with in-memory fakes. Same shape as
 * `people/types.ts`, the reference module.
 *
 * Every name here is prefixed `Inbox`/`UnifiedInbox` on purpose: one generated
 * `export *` barrel covers all CRM modules, so `Item`, `Channel` or
 * `Conversation` would collide.
 */

/**
 * Sources the inbox merges. Mirrors `INBOX_CHANNELS` in
 * `@yourcrm/database/src/schema/unified-inbox` — deliberately re-declared
 * rather than imported, because the domain layer must not depend on the
 * database package (`docs/architecture.md`). Named `…_NAMES` so importing
 * both packages in one file stays unambiguous.
 */
export const INBOX_CHANNEL_NAMES = ["email", "whatsapp", "call"] as const

export type InboxChannelName = (typeof INBOX_CHANNEL_NAMES)[number]

export function isInboxChannelName(value: unknown): value is InboxChannelName {
  return typeof value === "string" && (INBOX_CHANNEL_NAMES as readonly string[]).includes(value)
}

/**
 * Which conversations the caller may see, resolved from their role by
 * `inboxVisibilityScope`. Passed to the store, which turns it into a SQL
 * predicate so denied rows never reach pagination.
 */
export type InboxVisibility = { kind: "all" } | { kind: "own"; actorId: string }

/** Assignment filter. `any` means "do not filter on assignment". */
export type InboxAssignmentFilter =
  | { kind: "any" }
  | { kind: "unassigned" }
  | { kind: "user"; userId: string }

/** Pass-through record: outputs flow straight into the API envelope. */
export type InboxItemRecord = Record<string, unknown> & {
  id: string
  channel: InboxChannelName
  sourceId: string
}

/** What the service asks the store for, after permissions are resolved. */
export type InboxStoreQuery = {
  /** Channels the caller may read AND asked for. Empty means "no results". */
  channels: readonly InboxChannelName[]
  scope: InboxVisibility
  limit?: number
  cursor?: string | undefined
  order?: "asc" | "desc"
  unread?: boolean | undefined
  archived?: boolean | undefined
  assignment?: InboxAssignmentFilter
  personId?: string | undefined
  companyId?: string | undefined
  dealId?: string | undefined
}

export type InboxListResult = {
  data: InboxItemRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

/** The inbox-owned facts a mutation writes. Absent keys are left untouched. */
export type InboxStatePatch = {
  assignedTo?: string | null
  assignedAt?: Date | null
  assignedBy?: string | null
  readAt?: Date | null
  archivedAt?: Date | null
}

export type InboxStore = {
  list(workspaceId: string, query: InboxStoreQuery): Promise<InboxListResult>
  /** Must apply `scope`, so a denied item is indistinguishable from a missing one. */
  findItem(
    workspaceId: string,
    channel: InboxChannelName,
    sourceId: string,
    scope: InboxVisibility,
  ): Promise<InboxItemRecord | null>
  setState(
    workspaceId: string,
    channel: InboxChannelName,
    sourceId: string,
    patch: InboxStatePatch,
    actorId?: string,
  ): Promise<void>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type InboxAuditInput = {
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

export type UnifiedInboxServiceContext = ServiceContext

export type UnifiedInboxServiceDeps = {
  store: InboxStore
  audit: AuditWriter<InboxAuditInput>
  /**
   * Reserved. The inbox emits no domain events in P0: `@yourcrm/events`
   * exposes no `conversation.assigned` / `conversation.archived` /
   * `conversation.read` constant, and this module may not add one (see the
   * BLOCKER note in `service.ts`). Wiring stays here so adding the constants
   * is a change to `service.ts` alone.
   */
  events?: EventEmitter
}
