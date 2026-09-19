import { requirePermission } from "@yourcrm/permissions"
import {
  createSupportTicketCommentSchema,
  createSupportTicketSchema,
  supportTicketQuerySchema,
  transitionSupportTicketSchema,
  updateSupportTicketSchema,
} from "./schemas"
import type {
  SupportTicketCommentRecord,
  SupportTicketListResult,
  SupportTicketRecord,
  SupportTicketServiceContext,
  SupportTicketServiceDeps,
  SupportTicketWithComments,
} from "./types"

/**
 * Support/Ticketing domain service (spec 21-support, P0). Mirrors the people
 * reference module's shape; status lifecycle mirrors `quotes/service.ts`'s
 * explicit-transition pattern.
 *
 * EVENTS BLOCKER — read before wiring automation or notifications to this
 * module. `packages/events/src/envelope.ts` defines `CrmEvents`, `QuoteEvents`,
 * `InvoiceEvents`, `ConversationEvents`, etc., but there is currently no
 * ticket/support event group (spec 21 section 9 wants `ticket.created`,
 * `ticket.assigned`, `ticket.escalated`, `ticket.resolved`). Per the module's
 * hard rules, event names must come from a constant exported by
 * `@yourcrm/events`, string literals are forbidden, and this agent may not
 * add the missing group itself (`packages/events` is out of this worktree's
 * scope and is shared across every module). So every mutation below writes
 * an audit row (the `AuditWriter` port, backed by `writeAudit` in the route
 * file) but DOES NOT call `deps.events.emit(...)` — the `events` dependency
 * stays on `SupportTicketServiceDeps` only so wiring a `TicketEvents` group
 * later is a one-line change here, not a new port. Automation triggers listed
 * in spec 21 section 10 are blocked on the same gap, since automation listens
 * on the event bus. THIS IS A REPORTED BLOCKER, not a silent omission.
 */

export class SupportTicketNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`ticket ${id} not found`)
    this.name = "SupportTicketNotFoundError"
  }
}

export class InvalidSupportTicketTransitionError extends Error {
  readonly code = "INVALID_TRANSITION"
  constructor(message: string) {
    super(message)
    this.name = "InvalidSupportTicketTransitionError"
  }
}

function permissionOf(
  ctx: SupportTicketServiceContext,
  action: "read" | "create" | "update" | "delete",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "ticket",
    action,
  }
}

/** SLA minutes-to-deadline per priority. Read `computeSupportTicketSla` below. */
export type SupportTicketSlaMinutes = { firstResponse: number; resolution: number }

/**
 * Default SLA policy (spec 21 section 6/11: "SLA policies and timers").
 * Minutes-to-deadline, measured from ticket creation. No admin-configurable
 * SLA policy UI in P0 (spec calls that out as P1 "automation, integrations");
 * this is the sane-default extension point — `SupportTicketServiceDeps` has
 * no policy override today because nothing needs one yet, but
 * `computeSupportTicketSla`'s `policy` parameter is the seam for it.
 *
 * Typed over the literal priority union (not `Record<string, ...>`) so
 * `.normal` is statically guaranteed to exist — that guarantee is what lets
 * `computeSupportTicketSla` fall back to it without an unsound `!`.
 */
export const DEFAULT_SUPPORT_TICKET_SLA_POLICY: Record<
  "low" | "normal" | "high" | "urgent",
  SupportTicketSlaMinutes
> = {
  urgent: { firstResponse: 60, resolution: 240 },
  high: { firstResponse: 240, resolution: 1440 },
  normal: { firstResponse: 480, resolution: 4320 },
  low: { firstResponse: 1440, resolution: 7200 },
}

export type SupportTicketSlaDueDates = { firstResponseDueAt: Date; resolutionDueAt: Date }

/**
 * Pure SLA computation (mirrors `computeQuoteTotals`): given a priority and a
 * reference instant, returns when first response and resolution are due.
 * Unknown priorities fall back to `normal` rather than throwing — priority is
 * already zod-validated by the time this runs, so the fallback only matters
 * for defensive/direct callers (e.g. a future breach-scan job).
 */
export function computeSupportTicketSla(
  priority: string,
  from: Date,
  policy: Record<string, SupportTicketSlaMinutes> = DEFAULT_SUPPORT_TICKET_SLA_POLICY,
): SupportTicketSlaDueDates {
  const minutes = policy[priority] ?? policy.normal ?? DEFAULT_SUPPORT_TICKET_SLA_POLICY.normal
  return {
    firstResponseDueAt: new Date(from.getTime() + minutes.firstResponse * 60_000),
    resolutionDueAt: new Date(from.getTime() + minutes.resolution * 60_000),
  }
}

/**
 * Explicit status transition table (mirrors `quotes/service.ts`'s
 * `ALLOWED_TRANSITIONS`). `resolved` and `closed` both reopen to `open` only
 * — a ticket must go through triage again rather than jumping back to a
 * pending/resolved/closed state directly. No other edge is valid.
 */
const SUPPORT_TICKET_TRANSITIONS: Record<string, string[]> = {
  new: ["open", "resolved", "closed"],
  open: ["pending", "resolved", "closed"],
  pending: ["open", "resolved", "closed"],
  resolved: ["closed", "open"],
  closed: ["open"],
}

function assertSupportTicketTransition(from: string, to: string): void {
  const allowed = SUPPORT_TICKET_TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new InvalidSupportTicketTransitionError(
      `ticket: cannot transition from '${from}' to '${to}' (allowed from '${from}': ${
        allowed.length > 0 ? allowed.join(", ") : "none"
      })`,
    )
  }
}

/** Accepts either a `Date` (real repository rows) or an ISO string (test fixtures). */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value
  if (typeof value === "string") {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}

/**
 * Comments visible outside the staff view. Internal notes (`isInternal`)
 * must never reach a requester-facing surface — this is the one function
 * that decides that, so every present or future requester-facing path (the
 * customer portal, spec 45, is explicitly out of P0 scope but will consume
 * `SupportTicketService.getForRequester`, which is built on this) composes
 * it instead of re-deriving the rule. See `service.test.ts` for the proof.
 */
export function filterPublicSupportTicketComments(
  comments: SupportTicketCommentRecord[],
): SupportTicketCommentRecord[] {
  return comments.filter((comment) => comment.isInternal !== true)
}

/**
 * Support/Ticketing domain service.
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. does the work through the injected `SupportTicketStore` port;
 *  3. writes the audit row with before/after (mutations only) — see the
 *     EVENTS BLOCKER note above for why there is no event emission yet.
 */
export function createSupportTicketService(deps: SupportTicketServiceDeps) {
  const now = () => deps.now?.() ?? new Date()

  async function list(
    ctx: SupportTicketServiceContext,
    rawQuery: unknown,
  ): Promise<SupportTicketListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = supportTicketQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  /** Staff view: ticket plus every comment, public and internal. */
  async function get(
    ctx: SupportTicketServiceContext,
    id: string,
  ): Promise<SupportTicketWithComments> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findWithComments(ctx.workspaceId, id)
    if (!found) throw new SupportTicketNotFoundError(id)
    return found
  }

  /**
   * Requester-safe view: ticket plus only public comments. No P0 route calls
   * this (the customer portal is out of scope), but it exists and is tested
   * so the guarantee is real before anything is built on top of it.
   */
  async function getForRequester(
    ctx: SupportTicketServiceContext,
    id: string,
  ): Promise<SupportTicketWithComments> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findWithComments(ctx.workspaceId, id)
    if (!found) throw new SupportTicketNotFoundError(id)
    return { ticket: found.ticket, comments: filterPublicSupportTicketComments(found.comments) }
  }

  async function create(
    ctx: SupportTicketServiceContext,
    rawInput: unknown,
  ): Promise<SupportTicketRecord> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createSupportTicketSchema.parse(rawInput)
    const sla = computeSupportTicketSla(input.priority ?? "normal", now())
    const ticket = await deps.store.create(
      ctx.workspaceId,
      {
        ...input,
        firstResponseDueAt: sla.firstResponseDueAt,
        resolutionDueAt: sla.resolutionDueAt,
      } as Record<string, unknown>,
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "ticket",
      recordId: ticket.id,
      after: ticket,
      correlationId: ctx.correlationId,
    })
    return ticket
  }

  async function update(
    ctx: SupportTicketServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<SupportTicketRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateSupportTicketSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new SupportTicketNotFoundError(id)
    // A priority change re-bases the SLA clock from the ORIGINAL createdAt
    // with the NEW priority — escalating a ticket pulls its deadline
    // earlier even retroactively. Only touches whichever due date has not
    // already been hit: once a milestone actually happened, its due date is
    // history and stays put.
    const extra: Record<string, unknown> = {}
    const currentPriority = typeof before.priority === "string" ? before.priority : "normal"
    const nextPriority = patch.priority === undefined ? undefined : (patch.priority ?? "normal")
    if (nextPriority !== undefined && nextPriority !== currentPriority) {
      const sla = computeSupportTicketSla(nextPriority, toDate(before.createdAt))
      if (!before.firstResponseAt) extra.firstResponseDueAt = sla.firstResponseDueAt
      if (!before.resolvedAt) extra.resolutionDueAt = sla.resolutionDueAt
    }
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      { ...patch, ...extra } as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new SupportTicketNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "ticket",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(
    ctx: SupportTicketServiceContext,
    id: string,
  ): Promise<SupportTicketRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new SupportTicketNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "ticket",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(
    ctx: SupportTicketServiceContext,
    id: string,
  ): Promise<SupportTicketRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new SupportTicketNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "ticket",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * The only path a ticket's `status` ever changes on. Validates the edge
   * against `SUPPORT_TICKET_TRANSITIONS` and rejects anything else with
   * `InvalidSupportTicketTransitionError` (mapped to HTTP 409 by the route).
   * Entering `resolved`/`closed` stamps the matching timestamp; reopening to
   * `open` clears both, since a reopened ticket is — by definition — neither
   * resolved nor closed any more.
   */
  async function transition(
    ctx: SupportTicketServiceContext,
    id: string,
    rawInput: unknown,
  ): Promise<SupportTicketRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const { status: to } = transitionSupportTicketSchema.parse(rawInput)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new SupportTicketNotFoundError(id)
    const from = typeof before.status === "string" ? before.status : "new"
    assertSupportTicketTransition(from, to)
    const patch: Record<string, unknown> = { status: to }
    if (to === "resolved") patch.resolvedAt = now()
    if (to === "closed") patch.closedAt = now()
    if (to === "open") {
      patch.resolvedAt = null
      patch.closedAt = null
    }
    const after = await deps.store.update(ctx.workspaceId, id, patch, ctx.actorId)
    if (!after) throw new SupportTicketNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: to,
      object: "ticket",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Adds a comment (public reply or internal note). The FIRST public
   * comment on a ticket stamps `firstResponseAt` (spec 21's "first-response
   * timestamp") — internal notes never count as a response, and only the
   * first one sticks, matching `firstResponseDueAt`'s "how fast was the
   * first reply" intent.
   */
  async function addComment(
    ctx: SupportTicketServiceContext,
    ticketId: string,
    rawInput: unknown,
  ): Promise<{ ticket: SupportTicketRecord; comment: SupportTicketCommentRecord }> {
    requirePermission(permissionOf(ctx, "update"))
    const input = createSupportTicketCommentSchema.parse(rawInput)
    const ticketBefore = await deps.store.findById(ctx.workspaceId, ticketId)
    if (!ticketBefore) throw new SupportTicketNotFoundError(ticketId)
    const comment = await deps.store.addComment(
      ctx.workspaceId,
      ticketId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    let ticket = ticketBefore
    if (!input.isInternal && !ticketBefore.firstResponseAt) {
      const updated = await deps.store.update(
        ctx.workspaceId,
        ticketId,
        { firstResponseAt: now() },
        ctx.actorId,
      )
      if (updated) ticket = updated
    }
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "comment",
      object: "ticket_comment",
      recordId: comment.id,
      after: comment,
      correlationId: ctx.correlationId,
    })
    return { ticket, comment }
  }

  return {
    list,
    get,
    getForRequester,
    create,
    update,
    softDelete,
    restore,
    transition,
    addComment,
  }
}

export type SupportTicketService = ReturnType<typeof createSupportTicketService>
