import { and, eq, isNull, sql, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import { INBOX_CHANNELS, inboxItemStates, isInboxChannel } from "../schema/unified-inbox"
import type { InboxChannel } from "../schema/unified-inbox"
import { createBaseRepository } from "./base-repository"

/**
 * Unified inbox repository (spec 15-unified-inbox, P0).
 *
 * The only place unified-inbox SQL lives. It READS three tables owned by other
 * modules — `email_threads` (0210), `whatsapp_conversations` (0220) and `calls`
 * (0230) — and WRITES exactly one table of its own, `inbox_item_states` (0240).
 * It never updates a source row; the overlay carries every fact the inbox adds.
 *
 * WHY A UNION AND NOT A PROJECTION
 * --------------------------------
 * See the header of `../schema/unified-inbox.ts`. Short version: a projection
 * would have to be fed by three modules this one may not modify, so it could
 * drift with nobody to repair it, and it would buy no read win because each
 * source already indexes `(workspace_id, <activity timestamp>)`.
 *
 * HOW THE UNION STAYS CHEAP
 * -------------------------
 * `listItems` builds one CTE per requested channel. Each CTE carries the FULL
 * predicate set — workspace, soft delete, permission scope, channel-local
 * filters, the overlay join and the keyset cursor — and is then ordered and
 * cut to `limit + 1` rows. The outer query merges those pre-cut branches, sorts
 * once more and takes `limit + 1`.
 *
 * That per-branch `LIMIT` is sound because every branch is sorted by the same
 * key as the outer query: the global top-N of a union is always contained in
 * the union of each branch's top-N. So a page costs three bounded index scans
 * plus a merge of at most `3 * (limit + 1)` rows, whatever the workspace size.
 * It is also why the state join and every state filter live INSIDE the branch —
 * filtering after the union would let the outer `LIMIT` return short pages.
 *
 * ORDERING
 * --------
 * `(sortAt, sourceId)` descending (or ascending), on both the branch and the
 * outer query, with the cursor a keyset on the same pair. `sourceId` is a uuid
 * primary key from three disjoint tables, so the pair is a total order even
 * when two sources report the exact same timestamp — no duplicates, no dropped
 * rows at a page boundary. `sortAt` is COALESCEd to `created_at` so it is never
 * null and NULL-ordering can never differ between branches.
 *
 * PERMISSIONS
 * -----------
 * `InboxVisibilityScope` is always supplied by the domain service and is
 * applied inside each branch's WHERE — denied conversations are never counted,
 * never paginated and never revealed by a short page. Mirrors the
 * `ReportRowScope` contract in `reports-repository.ts`.
 */

export type { InboxChannel }
export { INBOX_CHANNELS, isInboxChannel }

/** Longest preview the stream returns; matches `whatsapp_conversations.last_message_preview`. */
export const INBOX_PREVIEW_MAX_LENGTH = 255

/** Default and maximum page size for the stream. */
export const INBOX_DEFAULT_LIMIT = 25
export const INBOX_MAX_LIMIT = 100

/**
 * Which conversations the caller may see.
 * `all`  — workspace-wide (admins/owners).
 * `own`  — conversations the caller owns, created, or is assigned, plus the
 *          unowned + unassigned shared queue.
 * Mirrors `ReportRowScope` (`reports-repository.ts`).
 */
export type InboxVisibilityScope = { kind: "all" } | { kind: "own"; actorId: string }

/** Assignment filter. `any` means "do not filter". */
export type InboxAssignmentFilter =
  | { kind: "any" }
  | { kind: "unassigned" }
  | { kind: "user"; userId: string }

export type InboxListOptions = {
  workspaceId: string
  /** Channels the caller may read. Empty means "no results". */
  channels: readonly InboxChannel[]
  scope: InboxVisibilityScope
  limit?: number
  cursor?: string | null
  order?: "asc" | "desc"
  /** true = unread only, false = read only, undefined = both. */
  unread?: boolean
  /** true = archived only, false = live only, undefined = both. */
  archived?: boolean
  assignment?: InboxAssignmentFilter
  personId?: string | null
  companyId?: string | null
  dealId?: string | null
  /** Restrict to one source row (used by `findItem`). */
  sourceId?: string | null
}

/** One row of the merged stream, after the overlay join and email enrichment. */
export type InboxItemRow = {
  /** Stable composite key, `"<channel>:<sourceId>"`. */
  id: string
  channel: InboxChannel
  sourceId: string
  workspaceId: string
  /** Last activity on the conversation — the stream's sort key. */
  sortAt: Date
  title: string | null
  participant: string | null
  preview: string | null
  direction: string | null
  status: string | null
  personId: string | null
  companyId: string | null
  dealId: string | null
  ownerId: string | null
  assignedTo: string | null
  assignedAt: Date | null
  readAt: Date | null
  archivedAt: Date | null
  unread: boolean
  archived: boolean
}

export type InboxItemStatePatch = {
  assignedTo?: string | null
  assignedAt?: Date | null
  assignedBy?: string | null
  readAt?: Date | null
  archivedAt?: Date | null
}

export class InvalidInboxCursorError extends Error {
  readonly code = "VALIDATION_ERROR"
  constructor(reason: string) {
    super(`inbox.list: ${reason}`)
    this.name = "InvalidInboxCursorError"
  }
}

/** `"<channel>:<sourceId>"` — the id the API and the web UI use for an item. */
export function inboxItemKey(channel: InboxChannel, sourceId: string): string {
  return `${channel}:${sourceId}`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertUuid(value: string, field: string): string {
  if (!UUID_RE.test(value)) throw new Error(`inbox: ${field} must be a uuid`)
  return value
}

/**
 * Keyset cursor over `(sortAt, sourceId)` — the exact pair the stream orders
 * by, so resuming a page cannot drop or repeat an item even when two sources
 * share a timestamp. Opaque to clients (base64url of `<iso>|<uuid>`).
 */
export function encodeInboxCursor(sortAt: Date, sourceId: string): string {
  const raw = `${sortAt.toISOString()}|${sourceId}`
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

export function decodeInboxCursor(
  cursor?: string | null,
): { sortAt: Date; sourceId: string } | null {
  if (cursor === null || cursor === undefined || cursor === "") return null
  let raw: string
  try {
    raw = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))
  } catch {
    throw new InvalidInboxCursorError("cursor is not a valid cursor token")
  }
  const at = raw.indexOf("|")
  if (at < 0) throw new InvalidInboxCursorError("cursor is not a valid cursor token")
  const sortAt = new Date(raw.slice(0, at))
  const sourceId = raw.slice(at + 1)
  if (Number.isNaN(sortAt.getTime()) || !UUID_RE.test(sourceId)) {
    throw new InvalidInboxCursorError("cursor is not a valid cursor token")
  }
  return { sortAt, sourceId }
}

/** Collapse whitespace and cut to {@link INBOX_PREVIEW_MAX_LENGTH}. */
export function inboxPreview(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = value.replace(/\s+/g, " ").trim()
  if (text.length === 0) return null
  return text.length > INBOX_PREVIEW_MAX_LENGTH
    ? `${text.slice(0, INBOX_PREVIEW_MAX_LENGTH - 1).trimEnd()}…`
    : text
}

/**
 * An item is unread while the read watermark is missing or older than the last
 * activity. Exported so the domain service and its tests share one definition.
 */
export function isInboxItemUnread(readAt: Date | null, sortAt: Date): boolean {
  return readAt === null || readAt.getTime() < sortAt.getTime()
}

// ---------------------------------------------------------------------------
// Branch construction
// ---------------------------------------------------------------------------

/**
 * Per-channel facts the shared predicate builder needs. `sortAt` is COALESCEd
 * so it is never null; `owner`/`createdBy` drive the permission scope; the
 * three link columns are null on channels that do not carry them, which turns
 * a filter on that link into "this branch contributes nothing".
 */
type BranchShape = {
  channel: InboxChannel
  table: string
  sortAt: string
  title: string
  participant: string
  preview: string
  direction: string
  status: string
  owner: string
  personId: string | null
  companyId: string | null
  dealId: string | null
}

const BRANCHES: Record<InboxChannel, BranchShape> = {
  email: {
    channel: "email",
    table: "email_threads",
    // Threads created before their first message fall back to created_at.
    sortAt: "COALESCE(t.last_message_at, t.created_at)",
    title: "t.subject",
    // Filled by the enrichment pass — email addresses live on email_messages.
    participant: "NULL::text",
    preview: "NULL::text",
    direction: "NULL::text",
    status: "t.status",
    owner: "t.owner_id",
    personId: "t.person_id",
    companyId: "t.company_id",
    dealId: "t.deal_id",
  },
  whatsapp: {
    channel: "whatsapp",
    table: "whatsapp_conversations",
    sortAt: "COALESCE(t.last_message_at, t.created_at)",
    title: "t.contact_phone",
    participant: "t.contact_phone",
    preview: "t.last_message_preview",
    direction: "NULL::text",
    status: "t.status",
    // whatsapp_conversations has no owner_id; created_by still applies.
    owner: "NULL::uuid",
    personId: "t.person_id",
    companyId: "t.company_id",
    dealId: null,
  },
  call: {
    channel: "call",
    table: "calls",
    sortAt: "COALESCE(t.started_at, t.created_at)",
    // A call has no subject line; the UI titles it from `participant`.
    title: "NULL::text",
    participant: "CASE WHEN t.direction = 'inbound' THEN t.from_number ELSE t.to_number END",
    preview: "COALESCE(t.disposition, t.notes)",
    direction: "t.direction",
    status: "t.status",
    owner: "t.owner_id",
    personId: "t.person_id",
    companyId: "t.company_id",
    dealId: "t.deal_id",
  },
}

/** Column list every branch projects, in the order `UNION ALL` requires. */
function branchProjection(shape: BranchShape): SQL {
  return sql`
    ${sql.raw(`'${shape.channel}'::text`)} AS "channel",
    t.id AS "sourceId",
    t.workspace_id AS "workspaceId",
    ${sql.raw(shape.sortAt)} AS "sortAt",
    ${sql.raw(shape.title)}::text AS "title",
    ${sql.raw(shape.participant)}::text AS "participant",
    ${sql.raw(shape.preview)}::text AS "preview",
    ${sql.raw(shape.direction)}::text AS "direction",
    ${sql.raw(shape.status)}::text AS "status",
    ${sql.raw(shape.personId ?? "NULL::uuid")} AS "personId",
    ${sql.raw(shape.companyId ?? "NULL::uuid")} AS "companyId",
    ${sql.raw(shape.dealId ?? "NULL::uuid")} AS "dealId",
    ${sql.raw(shape.owner)} AS "ownerId",
    s.assigned_to AS "assignedTo",
    s.assigned_at AS "assignedAt",
    s.read_at AS "readAt",
    s.archived_at AS "archivedAt"`
}

/**
 * Every predicate for one branch. Returns null when the filters make the
 * branch provably empty (e.g. a deal filter on WhatsApp, which has no
 * `deal_id`) — the caller then drops the branch instead of emitting SQL that
 * can only return nothing.
 */
function branchConditions(shape: BranchShape, opts: InboxListOptions): SQL[] | null {
  const sortAt = sql.raw(shape.sortAt)
  const conditions: SQL[] = [
    sql`t.workspace_id = ${opts.workspaceId}::uuid`,
    sql`t.deleted_at IS NULL`,
  ]

  if (opts.sourceId !== undefined && opts.sourceId !== null) {
    conditions.push(sql`t.id = ${assertUuid(opts.sourceId, "sourceId")}::uuid`)
  }

  // --- inbox overlay state -------------------------------------------------
  if (opts.archived === true) conditions.push(sql`s.archived_at IS NOT NULL`)
  if (opts.archived === false) conditions.push(sql`s.archived_at IS NULL`)

  if (opts.unread === true) {
    conditions.push(sql`(s.read_at IS NULL OR s.read_at < ${sortAt})`)
  }
  if (opts.unread === false) {
    conditions.push(sql`(s.read_at IS NOT NULL AND s.read_at >= ${sortAt})`)
  }

  const assignment = opts.assignment ?? { kind: "any" }
  if (assignment.kind === "unassigned") conditions.push(sql`s.assigned_to IS NULL`)
  if (assignment.kind === "user") {
    conditions.push(sql`s.assigned_to = ${assertUuid(assignment.userId, "assignedTo")}::uuid`)
  }

  // --- linked-record filters ----------------------------------------------
  const links: [string | null | undefined, string | null][] = [
    [opts.personId, shape.personId],
    [opts.companyId, shape.companyId],
    [opts.dealId, shape.dealId],
  ]
  for (const [wanted, column] of links) {
    if (wanted === undefined || wanted === null) continue
    // The channel cannot carry this link, so it can never match.
    if (column === null) return null
    conditions.push(sql`${sql.raw(column)} = ${assertUuid(wanted, "linked record id")}::uuid`)
  }

  // --- permission scope (in SQL, before pagination) ------------------------
  if (opts.scope.kind === "own") {
    const actor = assertUuid(opts.scope.actorId, "actorId")
    const owner = sql.raw(shape.owner)
    conditions.push(
      sql`(${owner} = ${actor}::uuid
        OR t.created_by = ${actor}::uuid
        OR s.assigned_to = ${actor}::uuid
        OR (${owner} IS NULL AND s.assigned_to IS NULL))`,
    )
  }

  // --- keyset cursor -------------------------------------------------------
  const cursor = decodeInboxCursor(opts.cursor)
  if (cursor) {
    const comparator = sql.raw(opts.order === "asc" ? ">" : "<")
    // Bound as an ISO string with an explicit cast: `db.execute` runs raw SQL,
    // so drizzle applies no column encoder and a bare Date never reaches the
    // wire protocol as a timestamp.
    const at = cursor.sortAt.toISOString()
    conditions.push(
      sql`(${sortAt} ${comparator} ${at}::timestamptz
        OR (${sortAt} = ${at}::timestamptz AND t.id ${comparator} ${cursor.sourceId}::uuid))`,
    )
  }

  return conditions
}

function branchQuery(shape: BranchShape, opts: InboxListOptions, fetch: number): SQL | null {
  const conditions = branchConditions(shape, opts)
  if (conditions === null) return null
  const direction = sql.raw(opts.order === "asc" ? "ASC" : "DESC")
  return sql`
    SELECT ${branchProjection(shape)}
    FROM ${sql.raw(shape.table)} t
    LEFT JOIN inbox_item_states s
      ON s.workspace_id = t.workspace_id
      AND s.channel = ${shape.channel}
      AND s.source_id = t.id
      AND s.deleted_at IS NULL
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY "sortAt" ${direction}, "sourceId" ${direction}
    LIMIT ${fetch}`
}

// ---------------------------------------------------------------------------
// Row decoding
// ---------------------------------------------------------------------------

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return typeof value === "string" ? value : String(value)
}

function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value
  const parsed = new Date(typeof value === "string" ? value : String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function toInboxItemRow(raw: Record<string, unknown>): InboxItemRow {
  const channel = asText(raw.channel)
  if (!isInboxChannel(channel)) throw new Error("inbox.list: row has an unknown channel")
  const sourceId = asText(raw.sourceId)
  const workspaceId = asText(raw.workspaceId)
  const sortAt = asDate(raw.sortAt)
  if (sourceId === null || workspaceId === null || sortAt === null) {
    throw new Error("inbox.list: row is missing its identity columns")
  }
  const readAt = asDate(raw.readAt)
  const archivedAt = asDate(raw.archivedAt)
  return {
    id: inboxItemKey(channel, sourceId),
    channel,
    sourceId,
    workspaceId,
    sortAt,
    title: asText(raw.title),
    participant: asText(raw.participant),
    preview: inboxPreview(asText(raw.preview)),
    direction: asText(raw.direction),
    status: asText(raw.status),
    personId: asText(raw.personId),
    companyId: asText(raw.companyId),
    dealId: asText(raw.dealId),
    ownerId: asText(raw.ownerId),
    assignedTo: asText(raw.assignedTo),
    assignedAt: asDate(raw.assignedAt),
    readAt,
    archivedAt,
    unread: isInboxItemUnread(readAt, sortAt),
    archived: archivedAt !== null,
  }
}

export function createUnifiedInboxRepository() {
  const base = createBaseRepository(inboxItemStates)

  /**
   * Fill `participant`/`preview`/`direction` for the email rows of one page.
   *
   * `email_threads` stores no address and no body, so those columns come from
   * the thread's newest message. It runs AFTER the page is cut, over at most
   * `limit` thread ids, using `email_messages_thread_idx (thread_id,
   * created_at)` — one extra bounded query per page, never a per-row lateral
   * inside the branch (which would run for every candidate, not every result).
   */
  async function enrichEmailRows(
    db: Database,
    workspaceId: string,
    rows: InboxItemRow[],
  ): Promise<void> {
    const threadIds = rows.filter((row) => row.channel === "email").map((row) => row.sourceId)
    if (threadIds.length === 0) return
    const idList = sql.join(
      threadIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )
    const statement = sql`
      SELECT DISTINCT ON (m.thread_id)
        m.thread_id AS "threadId",
        m.from_address AS "fromAddress",
        m.from_name AS "fromName",
        m.snippet AS "snippet",
        m.body_text AS "bodyText",
        m.direction AS "direction"
      FROM email_messages m
      WHERE m.workspace_id = ${workspaceId}::uuid
        AND m.deleted_at IS NULL
        AND m.thread_id IN (${idList})
      ORDER BY m.thread_id, m.created_at DESC`
    const raw = (await db.execute(statement)) as unknown as Record<string, unknown>[]
    const byThread = new Map<string, Record<string, unknown>>()
    for (const entry of Array.isArray(raw) ? raw : []) {
      const threadId = asText(entry.threadId)
      if (threadId !== null) byThread.set(threadId, entry)
    }
    for (const row of rows) {
      if (row.channel !== "email") continue
      const latest = byThread.get(row.sourceId)
      if (!latest) continue
      row.participant = asText(latest.fromName) ?? asText(latest.fromAddress)
      row.preview = inboxPreview(asText(latest.snippet) ?? asText(latest.bodyText))
      row.direction = asText(latest.direction)
    }
  }

  async function runStream(
    db: Database,
    opts: InboxListOptions,
    fetch: number,
  ): Promise<InboxItemRow[]> {
    const wanted = INBOX_CHANNELS.filter((channel) => opts.channels.includes(channel))
    const branches = wanted
      .map((channel) => ({ channel, query: branchQuery(BRANCHES[channel], opts, fetch) }))
      .filter((entry): entry is { channel: InboxChannel; query: SQL } => entry.query !== null)
    if (branches.length === 0) return []

    const direction = sql.raw(opts.order === "asc" ? "ASC" : "DESC")
    // One CTE per branch, each already ordered and cut to `fetch` rows. CTEs
    // (rather than parenthesised UNION arms) keep the generated SQL legal for
    // a single branch as well as three.
    const ctes = sql.join(
      branches.map((entry) => sql`${sql.raw(`inbox_${entry.channel}`)} AS (${entry.query})`),
      sql`, `,
    )
    const arms = sql.join(
      branches.map((entry) => sql`SELECT * FROM ${sql.raw(`inbox_${entry.channel}`)}`),
      sql` UNION ALL `,
    )
    const statement = sql`
      WITH ${ctes}
      SELECT * FROM (${arms}) AS inbox_stream
      ORDER BY "sortAt" ${direction}, "sourceId" ${direction}
      LIMIT ${fetch}`
    const raw = (await db.execute(statement)) as unknown as Record<string, unknown>[]
    return (Array.isArray(raw) ? raw : []).map(toInboxItemRow)
  }

  return {
    ...base,

    /**
     * One ordered, filtered, cursor-paginated page of the merged stream.
     * `opts.channels` and `opts.scope` are the permission facts, always
     * supplied by the domain service; an empty channel list short-circuits to
     * an empty page rather than to "everything".
     */
    async listItems(
      db: Database,
      opts: InboxListOptions,
    ): Promise<{
      data: InboxItemRow[]
      pagination: { nextCursor: string | null; limit: number }
    }> {
      const limit = Math.min(Math.max(opts.limit ?? INBOX_DEFAULT_LIMIT, 1), INBOX_MAX_LIMIT)
      const rows = await runStream(db, opts, limit + 1)
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      await enrichEmailRows(db, opts.workspaceId, page)
      const last = page[page.length - 1]
      return {
        data: page,
        pagination: {
          nextCursor: hasMore && last ? encodeInboxCursor(last.sortAt, last.sourceId) : null,
          limit,
        },
      }
    },

    /**
     * One item by (channel, source id), through the same permission scope as
     * the stream — so an actor who may not see a conversation gets `null` here
     * too, and the route turns that into 404 rather than leaking existence.
     * Archive/read/assignment filters are deliberately NOT applied: you must
     * be able to open and un-archive an archived item.
     */
    async findItem(
      db: Database,
      workspaceId: string,
      channel: InboxChannel,
      sourceId: string,
      scope: InboxVisibilityScope,
    ): Promise<InboxItemRow | null> {
      const rows = await runStream(
        db,
        { workspaceId, channels: [channel], scope, sourceId, order: "desc" },
        1,
      )
      const found = rows[0]
      if (!found) return null
      await enrichEmailRows(db, workspaceId, [found])
      return found
    },

    /**
     * Insert-or-update the overlay row for one item. Idempotent on
     * (workspace, channel, source id); writing state to a soft-deleted overlay
     * row revives it instead of duplicating it.
     */
    async upsertItemState(
      db: Database,
      workspaceId: string,
      channel: InboxChannel,
      sourceId: string,
      patch: InboxItemStatePatch,
      actorId?: string,
    ): Promise<void> {
      if (!isInboxChannel(channel)) {
        throw new Error(`inbox: channel must be one of ${INBOX_CHANNELS.join(", ")}`)
      }
      assertUuid(sourceId, "sourceId")
      const values = {
        ...(patch.assignedTo === undefined ? {} : { assignedTo: patch.assignedTo }),
        ...(patch.assignedAt === undefined ? {} : { assignedAt: patch.assignedAt }),
        ...(patch.assignedBy === undefined ? {} : { assignedBy: patch.assignedBy }),
        ...(patch.readAt === undefined ? {} : { readAt: patch.readAt }),
        ...(patch.archivedAt === undefined ? {} : { archivedAt: patch.archivedAt }),
      }
      await db
        .insert(inboxItemStates)
        .values({
          workspaceId,
          channel,
          sourceId,
          ...values,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .onConflictDoUpdate({
          target: [inboxItemStates.workspaceId, inboxItemStates.channel, inboxItemStates.sourceId],
          set: {
            ...values,
            updatedAt: new Date(),
            deletedAt: null,
            ...(actorId === undefined ? {} : { updatedBy: actorId }),
          },
        })
    },

    /** The raw overlay row, when one exists. Diagnostics and tests. */
    async findItemState(
      db: Database,
      workspaceId: string,
      channel: InboxChannel,
      sourceId: string,
    ) {
      const rows = await db
        .select()
        .from(inboxItemStates)
        .where(
          and(
            eq(inboxItemStates.workspaceId, workspaceId),
            eq(inboxItemStates.channel, channel),
            eq(inboxItemStates.sourceId, sourceId),
            isNull(inboxItemStates.deletedAt),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },
  }
}

export type UnifiedInboxRepository = ReturnType<typeof createUnifiedInboxRepository>
