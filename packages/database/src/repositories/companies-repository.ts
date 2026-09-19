import { and, eq, ilike, isNull, ne, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  companies,
  companyAddresses,
  isCompanyStatus,
  type Company,
  type CompanyAddress,
  type NewCompany,
} from "../schema/companies"
import { createBaseRepository } from "./base-repository"

export type CreateCompanyInput = {
  name: string
  domain?: string | null
  website?: string | null
  industry?: string | null
  size?: string | null
  ownerId?: string | null
  parentCompanyId?: string | null
  status?: string | null
  description?: string | null
  addresses?: {
    label?: string | null
    line1?: string | null
    city?: string | null
    region?: string | null
    postalCode?: string | null
    country?: string | null
    isPrimary?: boolean
  }[]
}

export type UpdateCompanyInput = Partial<
  Pick<
    NewCompany,
    | "name"
    | "domain"
    | "website"
    | "industry"
    | "size"
    | "ownerId"
    | "parentCompanyId"
    | "description"
  >
> & {
  status?: string | null
}

export type CompanyWithAddresses = {
  company: Company
  addresses: CompanyAddress[]
}

/** Trimmed, non-empty company name (max 255, mirrors the column). */
export function normalizeCompanyName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("companies.create: name must not be empty")
  if (trimmed.length > 255) throw new Error("companies.create: name must be at most 255 characters")
  return trimmed
}

export function normalizeCompanyDomain(domain: string): string {
  const trimmed = domain.trim().toLowerCase()
  if (trimmed.length === 0) throw new Error("companies.create: domain must not be empty")
  if (trimmed.length > 255)
    throw new Error("companies.create: domain must be at most 255 characters")
  return trimmed
}

function toCompanyValues(
  workspaceId: string,
  input: CreateCompanyInput | UpdateCompanyInput,
  actorId?: string,
): Partial<NewCompany> {
  const values: Partial<NewCompany> = {}
  if (input.name !== undefined) values.name = normalizeCompanyName(input.name)
  if (input.domain !== undefined) {
    values.domain = input.domain === null ? null : normalizeCompanyDomain(input.domain)
  }
  if (input.website !== undefined) values.website = input.website?.trim() || null
  if (input.industry !== undefined) values.industry = input.industry?.trim() || null
  if (input.size !== undefined) values.size = input.size?.trim() || null
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.parentCompanyId !== undefined) values.parentCompanyId = input.parentCompanyId
  if (input.description !== undefined) values.description = input.description
  if (input.status !== undefined) {
    if (input.status !== null && !isCompanyStatus(input.status)) {
      throw new Error(`companies.create: status must be one of active, archived`)
    }
    values.status = input.status ?? "active"
  }
  if (actorId !== undefined) {
    values.updatedBy = actorId
  }
  return { ...values, workspaceId }
}

/**
 * Workspace-scoped companies + addresses. The parent hierarchy stays inside
 * this table (self-reference); people attach via their own `company_id`
 * column, read through the People API rather than a join here.
 */
export function createCompaniesRepository() {
  const base = createBaseRepository(companies)

  async function insertAddresses(
    db: Database,
    workspaceId: string,
    companyId: string,
    input: Pick<CreateCompanyInput, "addresses">,
    actorId?: string,
  ): Promise<void> {
    for (const item of input.addresses ?? []) {
      await db.insert(companyAddresses).values({
        workspaceId,
        companyId,
        label: item.label?.trim() || null,
        line1: item.line1?.trim() || null,
        city: item.city?.trim() || null,
        region: item.region?.trim() || null,
        postalCode: item.postalCode?.trim() || null,
        country: item.country?.trim() || null,
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
      input: CreateCompanyInput,
      actorId?: string,
    ): Promise<Company> {
      if (input.parentCompanyId !== undefined && input.parentCompanyId !== null) {
        const parent = await base.findById(db, workspaceId, input.parentCompanyId)
        if (!parent) throw new Error("companies.create: parent company not found")
      }
      const rows = await db
        .insert(companies)
        .values({
          ...toCompanyValues(workspaceId, input, actorId),
          workspaceId,
          name: normalizeCompanyName(input.name),
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("companies.create: insert returned no rows")
      await insertAddresses(db, workspaceId, row.id, input, actorId)
      return row
    },

    /** Cursor-paginated list with optional case-insensitive name/domain/industry search. */
    async search(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" } & {
        query?: string
        status?: string
        industry?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const nameMatch = or(
          ilike(companies.name, q),
          ilike(companies.domain, q),
          ilike(companies.industry, q),
        )
        if (nameMatch) conditions.push(nameMatch)
      }
      if (opts.status) {
        if (!isCompanyStatus(opts.status))
          throw new Error("companies.search: unknown status filter")
        conditions.push(eq(companies.status, opts.status))
      }
      if (opts.industry) {
        conditions.push(eq(companies.industry, opts.industry))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as Company[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateCompanyInput,
      actorId?: string,
    ): Promise<Company | null> {
      if (input.parentCompanyId !== undefined && input.parentCompanyId !== null) {
        if (input.parentCompanyId === id)
          throw new Error("companies.update: a company cannot be its own parent")
        const parent = await base.findById(db, workspaceId, input.parentCompanyId)
        if (!parent) throw new Error("companies.update: parent company not found")
      }
      const rows = await db
        .update(companies)
        .set({ ...toCompanyValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(companies.id, id),
            eq(companies.workspaceId, workspaceId),
            isNull(companies.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<Company | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full Company shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as Company | null) ?? null
    },

    async findWithAddresses(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<CompanyWithAddresses | null> {
      const company = await this.findById(db, workspaceId, id)
      if (!company) return null
      const addresses = await db
        .select()
        .from(companyAddresses)
        .where(
          and(
            eq(companyAddresses.companyId, id),
            eq(companyAddresses.workspaceId, workspaceId),
            isNull(companyAddresses.deletedAt),
          ),
        )
      return { company, addresses }
    },

    async listChildren(db: Database, workspaceId: string, parentId: string): Promise<Company[]> {
      const rows = await db
        .select()
        .from(companies)
        .where(
          and(
            eq(companies.parentCompanyId, parentId),
            eq(companies.workspaceId, workspaceId),
            isNull(companies.deletedAt),
          ),
        )
      return rows
    },

    async addAddress(
      db: Database,
      workspaceId: string,
      companyId: string,
      input: {
        label?: string | null
        line1?: string | null
        city?: string | null
        region?: string | null
        postalCode?: string | null
        country?: string | null
        isPrimary?: boolean
      },
      actorId?: string,
    ): Promise<CompanyAddress> {
      const rows = await db
        .insert(companyAddresses)
        .values({
          workspaceId,
          companyId,
          label: input.label?.trim() || null,
          line1: input.line1?.trim() || null,
          city: input.city?.trim() || null,
          region: input.region?.trim() || null,
          postalCode: input.postalCode?.trim() || null,
          country: input.country?.trim() || null,
          isPrimary: input.isPrimary ?? false,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("companies.addAddress: insert returned no rows")
      if (row.isPrimary) await this.clearOtherPrimaries(db, workspaceId, row.id, companyId)
      return row
    },

    /** One primary address per company: demote every sibling row. */
    async clearOtherPrimaries(
      db: Database,
      workspaceId: string,
      keepId: string,
      companyId: string,
    ): Promise<void> {
      await db
        .update(companyAddresses)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(
          and(
            eq(companyAddresses.companyId, companyId),
            eq(companyAddresses.workspaceId, workspaceId),
            ne(companyAddresses.id, keepId),
            isNull(companyAddresses.deletedAt),
          ),
        )
    },
  }
}

export type CompaniesRepository = ReturnType<typeof createCompaniesRepository>
