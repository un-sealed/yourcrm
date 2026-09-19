import { CrmEvents, createEvent, getEventBus } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import { createPersonSchema, personQuerySchema, updatePersonSchema } from "./schemas"
import type {
  PeopleServiceContext,
  PeopleServiceDeps,
  PersonListResult,
  PersonRecord,
  PersonWithContacts,
} from "./types"

export class PersonNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`person ${id} not found`)
    this.name = "PersonNotFoundError"
  }
}

function permissionOf(ctx: PeopleServiceContext, action: "read" | "create" | "update" | "delete") {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "person",
    action,
  }
}

/**
 * People domain service (the golden reference for module agents).
 *
 * Every method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. does the work through the injected `PeopleStore` port;
 *  3. emits the domain event via the `CrmEvents` constant (never a literal);
 *  4. writes the audit row with before/after (mutations only).
 */
export function createPeopleService(deps: PeopleServiceDeps) {
  const events = deps.events ?? getEventBus()

  async function list(ctx: PeopleServiceContext, rawQuery: unknown): Promise<PersonListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = personQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(ctx: PeopleServiceContext, id: string): Promise<PersonWithContacts> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findWithContacts(ctx.workspaceId, id)
    if (!found) throw new PersonNotFoundError(id)
    return found
  }

  async function create(ctx: PeopleServiceContext, rawInput: unknown): Promise<PersonRecord> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createPersonSchema.parse(rawInput)
    const person = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await events.emit(
      createEvent({
        event: CrmEvents.PersonCreated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "person",
        entityId: person.id,
        after: person,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "person",
      recordId: person.id,
      after: person,
      correlationId: ctx.correlationId,
    })
    return person
  }

  async function update(
    ctx: PeopleServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<PersonRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updatePersonSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new PersonNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new PersonNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.PersonUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "person",
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
      object: "person",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(ctx: PeopleServiceContext, id: string): Promise<PersonRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new PersonNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await events.emit(
      createEvent({
        event: CrmEvents.PersonDeleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "person",
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "person",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(ctx: PeopleServiceContext, id: string): Promise<PersonRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new PersonNotFoundError(id)
    await events.emit(
      createEvent({
        event: CrmEvents.PersonUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "person",
        entityId: id,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "person",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  return { list, get, create, update, softDelete, restore }
}

export type PeopleService = ReturnType<typeof createPeopleService>
