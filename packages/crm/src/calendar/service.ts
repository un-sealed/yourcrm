import { createEvent, getEventBus } from "@yourcrm/events"
// `CalendarEvents` is defined in the events envelope but not re-exported from
// the package barrel (centrally owned); import the canonical constant from
// its defining module rather than repeating the strings locally (same
// pattern as the invoices module — see packages/crm/src/invoices/service.ts).
import { CalendarEvents } from "@yourcrm/events/src/envelope"
import { requirePermission } from "@yourcrm/permissions"
import {
  createCalendarEventSchema,
  calendarEventQuerySchema,
  updateCalendarEventSchema,
} from "./schemas"
import type {
  CalendarEventListResult,
  CalendarEventRecord,
  CalendarEventWithAttendees,
  CalendarServiceContext,
  CalendarServiceDeps,
} from "./types"

export class CalendarEventNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`calendar event ${id} not found`)
    this.name = "CalendarEventNotFoundError"
  }
}

function permissionOf(
  ctx: CalendarServiceContext,
  action: "read" | "create" | "update" | "delete",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "calendar_event",
    action,
  }
}

/**
 * Calendar domain service (mirrors the people reference — see
 * `../people/service.ts`).
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. does the work through the injected `CalendarStore` port;
 *  3. emits the domain event via the `CalendarEvents` constant (never a literal);
 *  4. writes the audit row with before/after (mutations only).
 *
 * SCOPE (P0): internal events only — no external sync, OAuth, booking
 * pages or recurrence. See `../calendar/types.ts` for the full note.
 */
export function createCalendarService(deps: CalendarServiceDeps) {
  const events = deps.events ?? getEventBus()

  async function list(
    ctx: CalendarServiceContext,
    rawQuery: unknown,
  ): Promise<CalendarEventListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = calendarEventQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(ctx: CalendarServiceContext, id: string): Promise<CalendarEventWithAttendees> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findWithAttendees(ctx.workspaceId, id)
    if (!found) throw new CalendarEventNotFoundError(id)
    return found
  }

  /** `workspaces.timezone` for rendering — never used to re-interpret storage. */
  async function getWorkspaceTimezone(ctx: CalendarServiceContext): Promise<string> {
    requirePermission(permissionOf(ctx, "read"))
    return deps.store.getWorkspaceTimezone(ctx.workspaceId)
  }

  async function create(
    ctx: CalendarServiceContext,
    rawInput: unknown,
  ): Promise<CalendarEventRecord> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createCalendarEventSchema.parse(rawInput)
    const event = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await events.emit(
      createEvent({
        event: CalendarEvents.EventCreated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "calendar_event",
        entityId: event.id,
        after: event,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "calendar_event",
      recordId: event.id,
      after: event,
      correlationId: ctx.correlationId,
    })
    return event
  }

  async function update(
    ctx: CalendarServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<CalendarEventRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateCalendarEventSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new CalendarEventNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new CalendarEventNotFoundError(id)
    await events.emit(
      createEvent({
        event: CalendarEvents.EventUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "calendar_event",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "calendar_event",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(ctx: CalendarServiceContext, id: string): Promise<CalendarEventRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new CalendarEventNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await events.emit(
      createEvent({
        event: CalendarEvents.EventDeleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "calendar_event",
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "calendar_event",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(ctx: CalendarServiceContext, id: string): Promise<CalendarEventRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new CalendarEventNotFoundError(id)
    await events.emit(
      createEvent({
        event: CalendarEvents.EventUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "calendar_event",
        entityId: id,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "calendar_event",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  return { list, get, getWorkspaceTimezone, create, update, softDelete, restore }
}

export type CalendarService = ReturnType<typeof createCalendarService>
