import { sql } from "drizzle-orm"
import { check, index, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core"
import { baseColumns, workspaceColumn } from "./base"

/**
 * Unified inbox (spec 15-unified-inbox, P0). Migration `0240_unified_inbox.sql`.
 *
 * AGGREGATION STRATEGY — read this before changing anything here.
 * ---------------------------------------------------------------
 * The inbox stream is NOT stored. It is a **query-time union** over the three
 * source tables that already own the conversations:
 *
 *   email_threads          (0210_email.sql)
 *   whatsapp_conversations (0220_whatsapp.sql)
 *   calls                  (0230_calling.sql)
 *
 * built in `repositories/unified-inbox-repository.ts`. The alternative — a
 * denormalised `inbox_items` projection written from source events, the shape
 * `search_index` (0110_search.sql) uses — was rejected here for two reasons
 * the search index does not have:
 *
 *  1. **Drift.** `search_index` is written by one indexing service that every
 *     module calls explicitly. An inbox projection would have to be written by
 *     three modules this module is forbidden to modify, so the only available
 *     hook is the in-process event bus — which misses every write that does not
 *     go through it (backfills, SQL fixes, a webhook handled by another
 *     process). A stale inbox silently hides customer messages; a stale search
 *     index only costs a recall miss.
 *  2. **No read win.** Search needs a projection because it needs one GIN
 *     tsvector across heterogeneous text. The inbox needs `ORDER BY
 *     last_activity DESC LIMIT n`, and all three source tables already carry a
 *     `(workspace_id, <timestamp>)` btree for exactly that. Three bounded index
 *     scans merged in Postgres is cheap; see the repository header for the
 *     per-branch `LIMIT` argument that keeps it that way.
 *
 * WHAT THIS TABLE IS
 * ------------------
 * `inbox_item_states` is the *overlay*: the inbox-owned facts that have nowhere
 * else to live, because the inbox may not add columns to the three source
 * tables. Exactly one sparse row per conversation the inbox has ever acted on
 * (assigned, read, archived) — conversations nobody has touched have no row at
 * all and the stream LEFT JOINs them as all-nulls.
 *
 * Because the overlay stores only facts the inbox itself writes, and the
 * *content* of the stream is read live from the sources, there is nothing to
 * backfill and nothing that can drift. A source row that is soft-deleted simply
 * stops joining; its orphaned state row is inert.
 *
 * `source_id` is a PLAIN uuid with an index and NO foreign key: it points at
 * whichever table `channel` names, and all three belong to other modules (same
 * rule as `search_index.record_id` and `people.company_id`). `assigned_to` and
 * `assigned_by` are plain uuids for the same reason — `users` is owned by the
 * auth foundation, and `owner_id` columns repo-wide are unconstrained too.
 */

/** Sources the inbox merges. Mirrored by `@yourcrm/crm` unified-inbox schemas. */
export const INBOX_CHANNELS = ["email", "whatsapp", "call"] as const

export type InboxChannel = (typeof INBOX_CHANNELS)[number]

export function isInboxChannel(value: unknown): value is InboxChannel {
  return typeof value === "string" && (INBOX_CHANNELS as readonly string[]).includes(value)
}

/**
 * Per-conversation inbox state. Sparse: a row exists only once somebody
 * assigns, reads or archives the conversation.
 *
 * `read_at` is a *watermark*, not a boolean: an item counts as unread when
 * `read_at IS NULL OR read_at < <last activity>`. That is what makes "mark
 * read" survive the next inbound message without the inbox writing to a source
 * table — the new message moves the activity timestamp past the watermark and
 * the item goes unread again by itself.
 */
export const inboxItemStates = pgTable(
  "inbox_item_states",
  {
    ...baseColumns,
    ...workspaceColumn,
    /** Which source table `source_id` addresses. */
    channel: varchar("channel", { length: 16 }).notNull(),
    /**
     * `email_threads.id` / `whatsapp_conversations.id` / `calls.id`.
     * Plain uuid, no FK — see header comment.
     */
    sourceId: uuid("source_id").notNull(),
    /** Assignee (`users.id`). Plain uuid, no FK — see header comment. */
    assignedTo: uuid("assigned_to"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    assignedBy: uuid("assigned_by"),
    /** Read watermark — see the type doc above. Null means "never read". */
    readAt: timestamp("read_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("inbox_item_states_workspace_idx").on(t.workspaceId),
    index("inbox_item_states_assignee_idx").on(t.workspaceId, t.assignedTo),
    index("inbox_item_states_archived_idx").on(t.workspaceId, t.archivedAt),
    index("inbox_item_states_source_idx").on(t.sourceId),
    // Join target for the stream and upsert target for every state write.
    // Full (not partial) so a soft-deleted overlay row is revived rather than
    // duplicated — same reasoning as `search_index_record_uidx`.
    uniqueIndex("inbox_item_states_item_uidx").on(t.workspaceId, t.channel, t.sourceId),
    check("inbox_item_states_channel_chk", sql`${t.channel} IN ('email', 'whatsapp', 'call')`),
  ],
)

export type InboxItemStateRow = typeof inboxItemStates.$inferSelect
export type NewInboxItemStateRow = typeof inboxItemStates.$inferInsert
