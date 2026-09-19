import { and, eq, ilike, isNull, ne, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  isPersonChannel,
  isPersonStatus,
  people,
  personEmails,
  personPhones,
  type NewPerson,
  type Person,
  type PersonEmail,
  type PersonPhone,
} from "../schema/people"
import { createBaseRepository } from "./base-repository"

export type CreatePersonInput = {
  firstName: string
  lastName?: string | null
  title?: string | null
  companyId?: string | null
  ownerId?: string | null
  status?: string | null
  preferredChannel?: string | null
  notes?: string | null
  emails?: { email: string; label?: string | null; isPrimary?: boolean }[]
  phones?: { phone: string; label?: string | null; isPrimary?: boolean }[]
}

export type UpdatePersonInput = Partial<
  Pick<NewPerson, "firstName" | "lastName" | "title" | "companyId" | "ownerId" | "notes">
> & {
  status?: string | null
  preferredChannel?: string | null
}

export type PersonWithContacts = {
  person: Person
  emails: PersonEmail[]
  phones: PersonPhone[]
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Trimmed, non-empty display name part (max 255, mirrors the column). */
export function normalizePersonName(value: string, field: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error(`people.create: ${field} must not be empty`)
  if (trimmed.length > 255)
    throw new Error(`people.create: ${field} must be at most 255 characters`)
  return trimmed
}

export function validatePersonEmail(email: string): string {
  const trimmed = email.trim().toLowerCase()
  if (!EMAIL_RE.test(trimmed)) throw new Error("people.create: email must be a valid address")
  if (trimmed.length > 320) throw new Error("people.create: email must be at most 320 characters")
  return trimmed
}

export function validatePersonPhone(phone: string): string {
  const trimmed = phone.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("people.create: phone must not be empty")
  if (trimmed.length > 64) throw new Error("people.create: phone must be at most 64 characters")
  return trimmed
}

function toPersonValues(
  workspaceId: string,
  input: CreatePersonInput | UpdatePersonInput,
  actorId?: string,
): Partial<NewPerson> {
  const values: Partial<NewPerson> = {}
  if (input.firstName !== undefined)
    values.firstName = normalizePersonName(input.firstName, "firstName")
  if (input.lastName !== undefined) {
    values.lastName =
      input.lastName === null ? null : normalizePersonName(input.lastName, "lastName")
  }
  if (input.title !== undefined) values.title = input.title?.trim() || null
  if (input.companyId !== undefined) values.companyId = input.companyId
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.notes !== undefined) values.notes = input.notes
  if (input.status !== undefined) {
    if (input.status !== null && !isPersonStatus(input.status)) {
      throw new Error(`people.create: status must be one of active, archived`)
    }
    values.status = input.status ?? "active"
  }
  if (input.preferredChannel !== undefined) {
    if (input.preferredChannel !== null && !isPersonChannel(input.preferredChannel)) {
      throw new Error(`people.create: preferredChannel must be one of email, phone, sms, whatsapp`)
    }
    values.preferredChannel = input.preferredChannel
  }
  if (actorId !== undefined) {
    values.updatedBy = actorId
  }
  return { ...values, workspaceId }
}

/**
 * Workspace-scoped people + contact methods. `companyId` stays a plain
 * column (no join here) until the companies module lands; tags, custom
 * fields and relationships attach via the shared repositories.
 */
export function createPeopleRepository() {
  const base = createBaseRepository(people)

  async function insertContacts(
    db: Database,
    workspaceId: string,
    personId: string,
    input: Pick<CreatePersonInput, "emails" | "phones">,
    actorId?: string,
  ): Promise<void> {
    for (const item of input.emails ?? []) {
      await db.insert(personEmails).values({
        workspaceId,
        personId,
        email: validatePersonEmail(item.email),
        label: item.label?.trim() || null,
        isPrimary: item.isPrimary ?? false,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      })
    }
    for (const item of input.phones ?? []) {
      await db.insert(personPhones).values({
        workspaceId,
        personId,
        phone: validatePersonPhone(item.phone),
        label: item.label?.trim() || null,
        isPrimary: item.isPrimary ?? false,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      })
    }
  }

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreatePersonInput,
      actorId?: string,
    ): Promise<Person> {
      const rows = await db
        .insert(people)
        .values({
          ...toPersonValues(workspaceId, input, actorId),
          workspaceId,
          firstName: normalizePersonName(input.firstName, "firstName"),
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("people.create: insert returned no rows")
      await insertContacts(db, workspaceId, row.id, input, actorId)
      return row
    },

    /** Cursor-paginated list with optional case-insensitive name/status search. */
    async search(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" } & {
        query?: string
        status?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const nameMatch = or(
          ilike(people.firstName, q),
          ilike(people.lastName, q),
          ilike(people.title, q),
        )
        if (nameMatch) conditions.push(nameMatch)
      }
      if (opts.status) {
        if (!isPersonStatus(opts.status)) throw new Error("people.search: unknown status filter")
        conditions.push(eq(people.status, opts.status))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as Person[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdatePersonInput,
      actorId?: string,
    ): Promise<Person | null> {
      const rows = await db
        .update(people)
        .set({ ...toPersonValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(
          and(eq(people.id, id), eq(people.workspaceId, workspaceId), isNull(people.deletedAt)),
        )
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<Person | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full Person shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as Person | null) ?? null
    },

    async findWithContacts(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<PersonWithContacts | null> {
      const person = await this.findById(db, workspaceId, id)
      if (!person) return null
      const emails = await db
        .select()
        .from(personEmails)
        .where(
          and(
            eq(personEmails.personId, id),
            eq(personEmails.workspaceId, workspaceId),
            isNull(personEmails.deletedAt),
          ),
        )
      const phones = await db
        .select()
        .from(personPhones)
        .where(
          and(
            eq(personPhones.personId, id),
            eq(personPhones.workspaceId, workspaceId),
            isNull(personPhones.deletedAt),
          ),
        )
      return { person, emails, phones }
    },

    async addEmail(
      db: Database,
      workspaceId: string,
      personId: string,
      input: { email: string; label?: string | null; isPrimary?: boolean },
      actorId?: string,
    ): Promise<PersonEmail> {
      const rows = await db
        .insert(personEmails)
        .values({
          workspaceId,
          personId,
          email: validatePersonEmail(input.email),
          label: input.label?.trim() || null,
          isPrimary: input.isPrimary ?? false,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("people.addEmail: insert returned no rows")
      if (row.isPrimary)
        await this.clearOtherPrimaries(db, workspaceId, personEmails, row.id, personId)
      return row
    },

    async addPhone(
      db: Database,
      workspaceId: string,
      personId: string,
      input: { phone: string; label?: string | null; isPrimary?: boolean },
      actorId?: string,
    ): Promise<PersonPhone> {
      const rows = await db
        .insert(personPhones)
        .values({
          workspaceId,
          personId,
          phone: validatePersonPhone(input.phone),
          label: input.label?.trim() || null,
          isPrimary: input.isPrimary ?? false,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("people.addPhone: insert returned no rows")
      if (row.isPrimary)
        await this.clearOtherPrimaries(db, workspaceId, personPhones, row.id, personId)
      return row
    },

    /** One primary per person per channel: demote every sibling row. */
    async clearOtherPrimaries(
      db: Database,
      workspaceId: string,
      table: typeof personEmails | typeof personPhones,
      keepId: string,
      personId: string,
    ): Promise<void> {
      await db
        .update(table)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(
          and(
            eq(table.personId, personId),
            eq(table.workspaceId, workspaceId),
            ne(table.id, keepId),
            isNull(table.deletedAt),
          ),
        )
    },
  }
}

export type PeopleRepository = ReturnType<typeof createPeopleRepository>
