/**
 * Unified Inbox module (spec 15-unified-inbox, P0).
 *
 * An AGGREGATOR over the Email (14), WhatsApp (16) and Calling (17) modules:
 * one ordered, filterable, cursor-paginated stream, plus assignment and
 * read/archive state. It reimplements none of them — opening an item links out
 * to the owning module's detail view.
 *
 * Every export is prefixed `Inbox`/`UnifiedInbox`/`inbox` on purpose:
 * `../index.ts` is a single generated `export *` barrel across all CRM
 * modules, so a generic name (`Item`, `Channel`, `Conversation`) would collide.
 */

export { createUnifiedInboxService, InboxItemNotFoundError, readWatermark } from "./service"
export type { UnifiedInboxService } from "./service"

export {
  assignInboxItemSchema,
  inboxChannelSchema,
  inboxItemQuerySchema,
  inboxItemRefSchema,
  inboxItemSchema,
} from "./schemas"
export type { AssignInboxItemInput, InboxItemDto, InboxItemQuery, InboxItemRef } from "./schemas"

export {
  INBOX_CHANNEL_PERMISSION_OBJECTS,
  INBOX_PERMISSION_OBJECT,
  inboxVisibilityScope,
  readableInboxChannels,
} from "./visibility"

export { INBOX_CHANNEL_NAMES, isInboxChannelName } from "./types"
export type {
  InboxAssignmentFilter,
  InboxAuditInput,
  InboxChannelName,
  InboxItemRecord,
  InboxListResult,
  InboxStatePatch,
  InboxStore,
  InboxStoreQuery,
  InboxVisibility,
  UnifiedInboxServiceContext,
  UnifiedInboxServiceDeps,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
