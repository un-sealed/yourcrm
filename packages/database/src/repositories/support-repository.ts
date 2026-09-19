import { and, asc, eq, ilike, isNull, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  isSupportTicketChannel,
  isSupportTicketPriority,
  isSupportTicketStatus,
  ticketComments,
  tickets,
  type NewSupportTicketRow,
  type SupportTicketCommentRow,
  type SupportTicketRow,
} from "../schema/support"
import { createBaseRepository } from "./base-repository"

export type CreateSupportTicketInput = {
  subject: string
  description?: string | null
  status?: string | null
  priority?: string | null
  requesterId: string
  assigneeId?: string | null
  channel?: string | null
  // Server-computed SLA due dates (see packages/crm/src/support/service.ts).
  // Never accepted from an API client — the crm-level create schema has no
  // field for either.
  firstResponseDueAt?: Date | null
  resolutionDueAt?: Date | null
}

export type UpdateSupportTicketInput = Partial<
  Pick<NewSupportTicketRow, "subject" | "description" | "assigneeId">
> & {
  status?: string | null
  priority?: string | null
  channel?: string | null
  firstResponseDueAt?: Date | null
  firstResponseAt?: Date | null
  resolutionDueAt?: Date | null
  resolvedAt?: Date | null
  closedAt?: Date | null
}

export type CreateSupportTicketCommentInput = {
  body: string
  isInternal?: boolean | null
}

export type SupportTicketWithComments = {
  ticket: SupportTicketRow
  comments: SupportTicketCommentRow[]
}

/** Trimmed, non-empty ticket subject (max 255, mirrors the column). */
export function normalizeTicketSubject(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("tickets.create: subject must not be empty")
  if (trimmed.length > 255)
    throw new Error("tickets.create: subject must be at most 255 characters")
  return trimmed
}

/** Trimmed, non-empty comment body (max 10000, mirrors the column). */
export function normalizeCommentBody(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error("ticketComments.create: body must not be empty")
  if (trimmed.length > 10000)
    throw new Error("ticketComments.create: body must be at most 10000 characters")
  return trimmed
}

function toTicketValues(
  workspaceId: string,
  input: CreateSupportTicketInput | UpdateSupportTicketInput,
  actorId?: string,
): Partial<NewSupportTicketRow> {
  const values: Partial<NewSupportTicketRow> = {}
  if (input.subject !== undefined) values.subject = normalizeTicketSubject(input.subject)
  if (input.description !== undefined) values.description = input.description
  if (input.assigneeId !== undefined) values.assigneeId = input.assigneeId
  if ("requesterId" in input && input.requesterId !== undefined) {
    if (input.requesterId.trim().length === 0) {
      throw new Error("tickets.create: requesterId must not be empty")
    }
    values.requesterId = input.requesterId
  }
  if (input.status !== undefined) {
    if (input.status !== null && !isSupportTicketStatus(input.status)) {
      throw new Error("tickets.create: status must be one of new, open, pending, resolved, closed")
    }
    values.status = input.status ?? "new"
  }
  if (input.priority !== undefined) {
    if (input.priority !== null && !isSupportTicketPriority(input.priority)) {
      throw new Error("tickets.create: priority must be one of low, normal, high, urgent")
    }
    values.priority = input.priority ?? "normal"
  }
  if (input.channel !== undefined) {
    if (input.channel !== null && !isSupportTicketChannel(input.channel)) {
      throw new Error(
        "tickets.create: channel must be one of email, chat, whatsapp, phone, web, api, manual",
      )
    }
    values.channel = input.channel ?? "manual"
  }
  if (input.firstResponseDueAt !== undefined) values.firstResponseDueAt = input.firstResponseDueAt
  if (input.resolutionDueAt !== undefined) values.resolutionDueAt = input.resolutionDueAt
  if ("firstResponseAt" in input && input.firstResponseAt !== undefined) {
    values.firstResponseAt = input.firstResponseAt
  }
  if ("resolvedAt" in input && input.resolvedAt !== undefined) {
    values.resolvedAt = input.resolvedAt
  }
  if ("closedAt" in input && input.closedAt !== undefined) {
    values.closedAt = input.closedAt
  }
  if (actorId !== undefined) values.updatedBy = actorId
  return { ...values, workspaceId }
}

/**
 * Workspace-scoped tickets + comments. `requesterId`/`assigneeId`/
 * `authorId` stay plain columns (no joins) — people and users are owned by
 * other module agents / the auth foundation. Status transitions and SLA
 * computation are the domain service's job (`packages/crm/src/support`);
 * this layer only persists whatever it is handed.
 */
export function createSupportTicketRepository() {
  const base = createBaseRepository(tickets)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateSupportTicketInput,
      actorId?: string,
    ): Promise<SupportTicketRow> {
      if (input.requesterId.trim().length === 0) {
        throw new Error("tickets.create: requesterId must not be empty")
      }
      const rows = await db
        .insert(tickets)
        .values({
          ...toTicketValues(workspaceId, input, actorId),
          workspaceId,
          subject: normalizeTicketSubject(input.subject),
          requesterId: input.requesterId,
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("tickets.create: insert returned no rows")
      return row
    },

    /** Cursor-paginated list with optional subject/description search + filters. */
    async search(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" } & {
        query?: string
        status?: string
        priority?: string
        assigneeId?: string
        requesterId?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const match = or(ilike(tickets.subject, q), ilike(tickets.description, q))
        if (match) conditions.push(match)
      }
      if (opts.status) {
        if (!isSupportTicketStatus(opts.status)) throw new Error("tickets.search: unknown status")
        conditions.push(eq(tickets.status, opts.status))
      }
      if (opts.priority) {
        if (!isSupportTicketPriority(opts.priority))
          throw new Error("tickets.search: unknown priority")
        conditions.push(eq(tickets.priority, opts.priority))
      }
      if (opts.assigneeId) conditions.push(eq(tickets.assigneeId, opts.assigneeId))
      if (opts.requesterId) conditions.push(eq(tickets.requesterId, opts.requesterId))
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as SupportTicketRow[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateSupportTicketInput,
      actorId?: string,
    ): Promise<SupportTicketRow | null> {
      const rows = await db
        .update(tickets)
        .set({ ...toTicketValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(
          and(eq(tickets.id, id), eq(tickets.workspaceId, workspaceId), isNull(tickets.deletedAt)),
        )
        .returning()
      return rows[0] ?? null
    },

    async findById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<SupportTicketRow | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full SupportTicketRow shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as SupportTicketRow | null) ?? null
    },

    async findWithComments(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<SupportTicketWithComments | null> {
      const ticket = await this.findById(db, workspaceId, id)
      if (!ticket) return null
      const comments = await db
        .select()
        .from(ticketComments)
        .where(
          and(
            eq(ticketComments.ticketId, id),
            eq(ticketComments.workspaceId, workspaceId),
            isNull(ticketComments.deletedAt),
          ),
        )
        .orderBy(asc(ticketComments.createdAt))
      return { ticket, comments }
    },

    async addComment(
      db: Database,
      workspaceId: string,
      ticketId: string,
      input: CreateSupportTicketCommentInput,
      actorId: string,
    ): Promise<SupportTicketCommentRow> {
      const rows = await db
        .insert(ticketComments)
        .values({
          workspaceId,
          ticketId,
          authorId: actorId,
          body: normalizeCommentBody(input.body),
          isInternal: input.isInternal ?? false,
          createdBy: actorId,
          updatedBy: actorId,
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("ticketComments.create: insert returned no rows")
      return row
    },
  }
}

export type SupportTicketRepository = ReturnType<typeof createSupportTicketRepository>
