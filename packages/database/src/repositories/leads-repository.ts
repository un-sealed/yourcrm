import { and, eq, ilike, isNull, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import { isLeadSource, isLeadStatus, leads, type Lead, type NewLead } from "../schema/leads"
import { createBaseRepository } from "./base-repository"

export type CreateLeadInput = {
  firstName: string
  lastName?: string | null
  email?: string | null
  phone?: string | null
  companyName?: string | null
  title?: string | null
  source?: string | null
  status?: string | null
  score?: number | null
  ownerId?: string | null
  notes?: string | null
  personId?: string | null
  companyId?: string | null
  dealId?: string | null
}

export type UpdateLeadInput = Partial<
  Pick<
    NewLead,
    | "firstName"
    | "lastName"
    | "email"
    | "phone"
    | "companyName"
    | "title"
    | "ownerId"
    | "notes"
    | "personId"
    | "companyId"
    | "dealId"
  >
> & {
  source?: string | null
  status?: string | null
  score?: number | null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Trimmed, non-empty display name part (max 255, mirrors the column). */
export function normalizeLeadName(value: string, field: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error(`leads.create: ${field} must not be empty`)
  if (trimmed.length > 255) throw new Error(`leads.create: ${field} must be at most 255 characters`)
  return trimmed
}

export function validateLeadEmail(email: string): string {
  const trimmed = email.trim().toLowerCase()
  if (!EMAIL_RE.test(trimmed)) throw new Error("leads.create: email must be a valid address")
  if (trimmed.length > 320) throw new Error("leads.create: email must be at most 320 characters")
  return trimmed
}

export function validateLeadScore(score: number): number {
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    throw new Error("leads.create: score must be an integer between 0 and 100")
  }
  return score
}

function toLeadValues(
  workspaceId: string,
  input: CreateLeadInput | UpdateLeadInput,
  actorId?: string,
): Partial<NewLead> {
  const values: Partial<NewLead> = {}
  if (input.firstName !== undefined)
    values.firstName = normalizeLeadName(input.firstName, "firstName")
  if (input.lastName !== undefined) {
    values.lastName =
      input.lastName === null || input.lastName === undefined
        ? null
        : normalizeLeadName(input.lastName, "lastName")
  }
  if (input.email !== undefined) {
    values.email =
      input.email === null || input.email === undefined ? null : validateLeadEmail(input.email)
  }
  if (input.phone !== undefined) {
    const trimmed = input.phone?.trim().replace(/\s+/g, " ") || null
    if (trimmed !== null && trimmed.length > 64) {
      throw new Error("leads.create: phone must be at most 64 characters")
    }
    values.phone = trimmed
  }
  if (input.companyName !== undefined) values.companyName = input.companyName?.trim() || null
  if (input.title !== undefined) values.title = input.title?.trim() || null
  if (input.source !== undefined) {
    if (input.source !== null && !isLeadSource(input.source)) {
      throw new Error(`leads.create: source must be one of ${LEAD_SOURCE_LIST}`)
    }
    values.source = input.source ?? "manual"
  }
  if (input.status !== undefined) {
    if (input.status !== null && !isLeadStatus(input.status)) {
      throw new Error(`leads.create: status must be one of ${LEAD_STATUS_LIST}`)
    }
    values.status = input.status ?? "new"
  }
  if (input.score !== undefined) {
    values.score = input.score === null ? 0 : validateLeadScore(input.score)
  }
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.notes !== undefined) values.notes = input.notes
  if (input.personId !== undefined) values.personId = input.personId
  if (input.companyId !== undefined) values.companyId = input.companyId
  if (input.dealId !== undefined) values.dealId = input.dealId
  if (actorId !== undefined) {
    values.updatedBy = actorId
  }
  return { ...values, workspaceId }
}

const LEAD_STATUS_LIST = "new, working, qualified, unqualified, converted"
const LEAD_SOURCE_LIST = "manual, form, meta, google, whatsapp, indiamart, justdial, tradeindia"

/**
 * Workspace-scoped leads. `personId` / `companyId` / `dealId` stay plain
 * columns (no join here) until the owning modules land; conversion stores
 * the target ids only.
 */
export function createLeadsRepository() {
  const base = createBaseRepository(leads)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateLeadInput,
      actorId?: string,
    ): Promise<Lead> {
      const rows = await db
        .insert(leads)
        .values({
          ...toLeadValues(workspaceId, input, actorId),
          workspaceId,
          firstName: normalizeLeadName(input.firstName, "firstName"),
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("leads.create: insert returned no rows")
      return row
    },

    /** Cursor-paginated list with optional text/status/source search. */
    async search(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" } & {
        query?: string
        status?: string
        source?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const textMatch = or(
          ilike(leads.firstName, q),
          ilike(leads.lastName, q),
          ilike(leads.email, q),
          ilike(leads.companyName, q),
        )
        if (textMatch) conditions.push(textMatch)
      }
      if (opts.status) {
        if (!isLeadStatus(opts.status)) throw new Error("leads.search: unknown status filter")
        conditions.push(eq(leads.status, opts.status))
      }
      if (opts.source) {
        if (!isLeadSource(opts.source)) throw new Error("leads.search: unknown source filter")
        conditions.push(eq(leads.source, opts.source))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as Lead[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateLeadInput,
      actorId?: string,
    ): Promise<Lead | null> {
      const rows = await db
        .update(leads)
        .set({ ...toLeadValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(and(eq(leads.id, id), eq(leads.workspaceId, workspaceId), isNull(leads.deletedAt)))
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<Lead | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full Lead shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as Lead | null) ?? null
    },
  }
}

export type LeadsRepository = ReturnType<typeof createLeadsRepository>
