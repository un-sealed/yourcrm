import { and, asc, desc, eq, ilike, isNull, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import { deals, isDealStage, type Deal, type NewDeal } from "../schema/deals"
import { createBaseRepository } from "./base-repository"

export type CreateDealInput = {
  name: string
  amount?: string | number | null
  currency?: string | null
  pipelineId?: string | null
  stageId?: string | null
  stage?: string | null
  probability?: number | null
  expectedCloseDate?: string | null
  personId?: string | null
  companyId?: string | null
  ownerId?: string | null
  closeReason?: string | null
  notes?: string | null
}

export type UpdateDealInput = Partial<
  Pick<
    NewDeal,
    | "name"
    | "amount"
    | "currency"
    | "pipelineId"
    | "personId"
    | "companyId"
    | "ownerId"
    | "closeReason"
    | "notes"
  >
> & {
  probability?: number | null
  expectedCloseDate?: string | null
}

export type ChangeDealStageInput = {
  stage: string
  stageId?: string | null
}

export type CloseDealInput = {
  stage: "won" | "lost"
  closeReason?: string | null
}

export type DealSortColumn = "name" | "amount" | "expectedCloseDate" | "createdAt"

export function isDealSortColumn(value: unknown): value is DealSortColumn {
  return (
    value === "name" || value === "amount" || value === "expectedCloseDate" || value === "createdAt"
  )
}

/** Trimmed, non-empty deal name (max 255, mirrors the column). */
export function normalizeDealName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error("deals.create: name must not be empty")
  if (trimmed.length > 255) throw new Error("deals.create: name must be at most 255 characters")
  return trimmed
}

/** NUMERIC(14,2) as a plain decimal string; null clears the value. */
export function normalizeDealAmount(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const num = typeof value === "number" ? value : Number(String(value).trim())
  if (!Number.isFinite(num)) throw new Error("deals.create: amount must be a number")
  if (num < 0) throw new Error("deals.create: amount must be zero or more")
  if (num >= 1000000000000) throw new Error("deals.create: amount is too large")
  return num.toFixed(2)
}

/** ISO 4217-ish 3-letter code, uppercased; null resets to USD. */
export function normalizeDealCurrency(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === "") return "USD"
  const trimmed = value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(trimmed)) throw new Error("deals.create: currency must be a 3-letter code")
  return trimmed
}

export function normalizeDealProbability(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("deals.create: probability must be an integer from 0 to 100")
  }
  return value
}

/** YYYY-MM-DD calendar date (mirrors the DATE column); null clears it. */
export function normalizeDealCloseDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === "") return null
  const trimmed = value.trim().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error("deals.create: expectedCloseDate must be YYYY-MM-DD")
  }
  const parsed = new Date(`${trimmed}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) throw new Error("deals.create: expectedCloseDate is invalid")
  return trimmed
}

export function normalizeDealStage(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === "") return "qualification"
  const trimmed = value.trim()
  if (!isDealStage(trimmed)) {
    throw new Error(`deals.create: stage must be one of ${dealStageList()}`)
  }
  return trimmed
}

function dealStageList(): string {
  return "qualification, discovery, proposal, negotiation, won, lost"
}

function toDealValues(
  workspaceId: string,
  input: CreateDealInput | UpdateDealInput,
  actorId?: string,
): Partial<NewDeal> {
  const values: Partial<NewDeal> = {}
  if (input.name !== undefined) values.name = normalizeDealName(input.name)
  if (input.amount !== undefined) values.amount = normalizeDealAmount(input.amount)
  if (input.currency !== undefined) values.currency = normalizeDealCurrency(input.currency)
  if (input.pipelineId !== undefined) values.pipelineId = input.pipelineId
  if (input.personId !== undefined) values.personId = input.personId
  if (input.companyId !== undefined) values.companyId = input.companyId
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.closeReason !== undefined) {
    const reason = input.closeReason?.trim() ?? ""
    if (reason.length > 255) throw new Error("deals.create: closeReason is too long")
    values.closeReason = reason === "" ? null : reason
  }
  if (input.notes !== undefined) values.notes = input.notes
  if (input.probability !== undefined)
    values.probability = normalizeDealProbability(input.probability)
  if (input.expectedCloseDate !== undefined) {
    values.expectedCloseDate = normalizeDealCloseDate(input.expectedCloseDate)
  }
  if (actorId !== undefined) {
    values.updatedBy = actorId
  }
  return { ...values, workspaceId }
}

/** Amount * probability / 100, derived client-side — never stored. */
export function dealWeightedValue(
  amount: string | number | null | undefined,
  probability: number | null | undefined,
): number | null {
  if (
    amount === null ||
    amount === undefined ||
    probability === null ||
    probability === undefined
  ) {
    return null
  }
  const num = typeof amount === "number" ? amount : Number(amount)
  if (!Number.isFinite(num)) return null
  return Math.round(num * (probability / 100) * 100) / 100
}

/**
 * Workspace-scoped deals. `pipelineId` / `stageId` / `personId` / `companyId`
 * stay plain columns (no joins here) until their owning modules land; tags,
 * custom fields and relationships attach via the shared repositories.
 */
export function createDealsRepository() {
  const base = createBaseRepository(deals)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateDealInput,
      actorId?: string,
    ): Promise<Deal> {
      const rows = await db
        .insert(deals)
        .values({
          ...toDealValues(workspaceId, input, actorId),
          workspaceId,
          name: normalizeDealName(input.name),
          stage: normalizeDealStage(input.stage),
          stageId: input.stageId ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("deals.create: insert returned no rows")
      return row
    },

    /**
     * Cursor-paginated list with optional name search plus stage / pipeline
     * filters and server-side sorting. Every read stays workspace-scoped and
     * soft-delete aware (same conditions as the shared base repository).
     */
    async search(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" } & {
        query?: string
        stage?: string
        pipelineId?: string
        sort?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const nameMatch = or(ilike(deals.name, q), ilike(deals.notes, q))
        if (nameMatch) conditions.push(nameMatch)
      }
      if (opts.stage) {
        if (!isDealStage(opts.stage)) throw new Error("deals.search: unknown stage filter")
        conditions.push(eq(deals.stage, opts.stage))
      }
      if (opts.pipelineId) conditions.push(eq(deals.pipelineId, opts.pipelineId))
      if (opts.sort !== undefined && !isDealSortColumn(opts.sort)) {
        throw new Error("deals.search: unknown sort column")
      }
      const sortColumn =
        opts.sort === "name"
          ? deals.name
          : opts.sort === "amount"
            ? deals.amount
            : opts.sort === "expectedCloseDate"
              ? deals.expectedCloseDate
              : deals.createdAt
      const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200)
      const ordering = opts.order === "asc" ? asc(sortColumn) : desc(sortColumn)
      const rows = await db
        .select()
        .from(deals)
        .where(and(eq(deals.workspaceId, opts.workspaceId), isNull(deals.deletedAt), ...conditions))
        .orderBy(ordering)
        .limit(limit + 1)
      const hasMore = rows.length > limit
      const data = (hasMore ? rows.slice(0, limit) : rows) as Deal[]
      const last = data[data.length - 1]
      return {
        data,
        pagination: { nextCursor: hasMore ? (last?.id ?? null) : null, limit },
      }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateDealInput,
      actorId?: string,
    ): Promise<Deal | null> {
      const rows = await db
        .update(deals)
        .set({ ...toDealValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(and(eq(deals.id, id), eq(deals.workspaceId, workspaceId), isNull(deals.deletedAt)))
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<Deal | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full Deal shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as Deal | null) ?? null
    },

    /** Stage moves go through this method so every transition is auditable. */
    async changeStage(
      db: Database,
      workspaceId: string,
      id: string,
      input: ChangeDealStageInput,
      actorId?: string,
    ): Promise<Deal | null> {
      const stage = normalizeDealStage(input.stage)
      const rows = await db
        .update(deals)
        .set({
          stage,
          stageId: input.stageId ?? null,
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(and(eq(deals.id, id), eq(deals.workspaceId, workspaceId), isNull(deals.deletedAt)))
        .returning()
      return rows[0] ?? null
    },

    /** Close a deal as won/lost (stage + optional reason in one write). */
    async close(
      db: Database,
      workspaceId: string,
      id: string,
      input: CloseDealInput,
      actorId?: string,
    ): Promise<Deal | null> {
      const reason = input.closeReason?.trim() ?? ""
      if (reason.length > 255) throw new Error("deals.create: closeReason is too long")
      const rows = await db
        .update(deals)
        .set({
          stage: input.stage,
          closeReason: reason === "" ? null : reason,
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(and(eq(deals.id, id), eq(deals.workspaceId, workspaceId), isNull(deals.deletedAt)))
        .returning()
      return rows[0] ?? null
    },
  }
}

export type DealsRepository = ReturnType<typeof createDealsRepository>
