import { and, asc, eq, ilike, isNull, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  DEFAULT_SALES_PIPELINE,
  isPipelineStatus,
  pipelineStages,
  pipelines,
  type NewPipeline,
  type Pipeline,
  type PipelineStage,
} from "../schema/pipelines"
import { createBaseRepository } from "./base-repository"

export type CreateStageInput = {
  name: string
  color?: string | null
  position?: number
  probability?: number
  isWon?: boolean
  isLost?: boolean
}

export type CreatePipelineInput = {
  name: string
  description?: string | null
  ownerId?: string | null
  status?: string | null
  isDefault?: boolean
  stages?: CreateStageInput[]
}

export type UpdatePipelineInput = Partial<
  Pick<NewPipeline, "name" | "description" | "ownerId" | "isDefault">
> & {
  status?: string | null
}

export type UpdateStageInput = Partial<
  Pick<PipelineStage, "name" | "color" | "probability" | "isWon" | "isLost">
>

export type PipelineWithStages = {
  pipeline: Pipeline
  stages: PipelineStage[]
}

/** Trimmed, non-empty name (max 255, mirrors the column). */
export function normalizePipelineName(value: string, field: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error(`pipelines.create: ${field} must not be empty`)
  if (trimmed.length > 255)
    throw new Error(`pipelines.create: ${field} must be at most 255 characters`)
  return trimmed
}

export function validateStageProbability(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("pipelines.create: probability must be an integer between 0 and 100")
  }
  return value
}

function assertTerminalFlags(isWon: boolean, isLost: boolean): void {
  if (isWon && isLost) throw new Error("pipelines.create: a stage cannot be both won and lost")
}

function toPipelineValues(
  workspaceId: string,
  input: CreatePipelineInput | UpdatePipelineInput,
  actorId?: string,
): Partial<NewPipeline> {
  const values: Partial<NewPipeline> = {}
  if (input.name !== undefined) values.name = normalizePipelineName(input.name, "name")
  if (input.description !== undefined) values.description = input.description?.trim() || null
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.isDefault !== undefined) values.isDefault = input.isDefault
  if (input.status !== undefined) {
    if (input.status !== null && !isPipelineStatus(input.status)) {
      throw new Error(`pipelines.create: status must be one of active, archived`)
    }
    values.status = input.status ?? "active"
  }
  if (actorId !== undefined) {
    values.updatedBy = actorId
  }
  return { ...values, workspaceId }
}

function toStageValues(input: CreateStageInput | UpdateStageInput): {
  name?: string
  color?: string | null
  probability?: number
  isWon?: boolean
  isLost?: boolean
} {
  const values: {
    name?: string
    color?: string | null
    probability?: number
    isWon?: boolean
    isLost?: boolean
  } = {}
  if (input.name !== undefined) values.name = normalizePipelineName(input.name, "stage name")
  if (input.color !== undefined) {
    const color = input.color?.trim() || null
    if (color !== null && color.length > 32) {
      throw new Error("pipelines.create: color must be at most 32 characters")
    }
    values.color = color
  }
  if (input.probability !== undefined)
    values.probability = validateStageProbability(input.probability)
  if (input.isWon !== undefined || input.isLost !== undefined) {
    values.isWon = input.isWon ?? false
    values.isLost = input.isLost ?? false
    assertTerminalFlags(values.isWon, values.isLost)
  }
  return values
}

/**
 * Workspace-scoped pipelines + ordered stages. Stage rows are soft-delete
 * aware; `position` is a dense 0-based order maintained by `reorderStages`.
 */
export function createPipelinesRepository() {
  const base = createBaseRepository(pipelines)

  async function insertStages(
    db: Database,
    workspaceId: string,
    pipelineId: string,
    stages: CreateStageInput[],
    actorId?: string,
  ): Promise<PipelineStage[]> {
    const created: PipelineStage[] = []
    for (const [index, item] of stages.entries()) {
      const values = toStageValues(item)
      const rows = await db
        .insert(pipelineStages)
        .values({
          workspaceId,
          pipelineId,
          name: values.name ?? normalizePipelineName(item.name, "stage name"),
          color: values.color ?? null,
          position: item.position ?? index,
          probability: values.probability ?? 0,
          isWon: values.isWon ?? false,
          isLost: values.isLost ?? false,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("pipelines.create: stage insert returned no rows")
      created.push(row)
    }
    return created
  }

  async function listStages(
    db: Database,
    workspaceId: string,
    pipelineId: string,
  ): Promise<PipelineStage[]> {
    return db
      .select()
      .from(pipelineStages)
      .where(
        and(
          eq(pipelineStages.pipelineId, pipelineId),
          eq(pipelineStages.workspaceId, workspaceId),
          isNull(pipelineStages.deletedAt),
        ),
      )
      .orderBy(asc(pipelineStages.position))
  }

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreatePipelineInput,
      actorId?: string,
    ): Promise<PipelineWithStages> {
      const rows = await db
        .insert(pipelines)
        .values({
          ...toPipelineValues(workspaceId, input, actorId),
          workspaceId,
          name: normalizePipelineName(input.name, "name"),
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("pipelines.create: insert returned no rows")
      const stages = await insertStages(db, workspaceId, row.id, input.stages ?? [], actorId)
      return { pipeline: row, stages }
    },

    async createDefault(
      db: Database,
      workspaceId: string,
      actorId?: string,
    ): Promise<PipelineWithStages> {
      return this.create(
        db,
        workspaceId,
        {
          name: DEFAULT_SALES_PIPELINE.name,
          description: DEFAULT_SALES_PIPELINE.description,
          isDefault: true,
          stages: DEFAULT_SALES_PIPELINE.stages.map((s) => ({ ...s })),
        },
        actorId,
      )
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
        const nameMatch = or(ilike(pipelines.name, q), ilike(pipelines.description, q))
        if (nameMatch) conditions.push(nameMatch)
      }
      if (opts.status) {
        if (!isPipelineStatus(opts.status))
          throw new Error("pipelines.search: unknown status filter")
        conditions.push(eq(pipelines.status, opts.status))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as Pipeline[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdatePipelineInput,
      actorId?: string,
    ): Promise<Pipeline | null> {
      const rows = await db
        .update(pipelines)
        .set({ ...toPipelineValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(pipelines.id, id),
            eq(pipelines.workspaceId, workspaceId),
            isNull(pipelines.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<Pipeline | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full Pipeline shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as Pipeline | null) ?? null
    },

    async findWithStages(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<PipelineWithStages | null> {
      const pipeline = await this.findById(db, workspaceId, id)
      if (!pipeline) return null
      const stages = await listStages(db, workspaceId, id)
      return { pipeline, stages }
    },

    async addStage(
      db: Database,
      workspaceId: string,
      pipelineId: string,
      input: CreateStageInput,
      actorId?: string,
    ): Promise<PipelineStage | null> {
      const pipeline = await this.findById(db, workspaceId, pipelineId)
      if (!pipeline) return null
      const existing = await listStages(db, workspaceId, pipelineId)
      const created = await insertStages(
        db,
        workspaceId,
        pipelineId,
        [{ ...input, position: input.position ?? existing.length }],
        actorId,
      )
      return created[0] ?? null
    },

    async updateStage(
      db: Database,
      workspaceId: string,
      pipelineId: string,
      stageId: string,
      input: UpdateStageInput,
      actorId?: string,
    ): Promise<PipelineStage | null> {
      const current = await db
        .select()
        .from(pipelineStages)
        .where(
          and(
            eq(pipelineStages.id, stageId),
            eq(pipelineStages.pipelineId, pipelineId),
            eq(pipelineStages.workspaceId, workspaceId),
            isNull(pipelineStages.deletedAt),
          ),
        )
        .limit(1)
      const row = current[0]
      if (!row) return null
      const patch = toStageValues(input)
      assertTerminalFlags(patch.isWon ?? row.isWon, patch.isLost ?? row.isLost)
      const rows = await db
        .update(pipelineStages)
        .set({
          ...patch,
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(eq(pipelineStages.id, stageId))
        .returning()
      return rows[0] ?? null
    },

    async removeStage(
      db: Database,
      workspaceId: string,
      pipelineId: string,
      stageId: string,
      actorId?: string,
    ): Promise<boolean> {
      const rows = await db
        .update(pipelineStages)
        .set({
          deletedAt: new Date(),
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(
          and(
            eq(pipelineStages.id, stageId),
            eq(pipelineStages.pipelineId, pipelineId),
            eq(pipelineStages.workspaceId, workspaceId),
            isNull(pipelineStages.deletedAt),
          ),
        )
        .returning({ id: pipelineStages.id })
      return (rows.length ?? 0) > 0
    },

    /**
     * Persist a drag-to-reorder result: `orderedIds` must contain exactly
     * the live stage ids of the pipeline, in their new order.
     */
    async reorderStages(
      db: Database,
      workspaceId: string,
      pipelineId: string,
      orderedIds: string[],
      actorId?: string,
    ): Promise<PipelineStage[]> {
      const pipeline = await this.findById(db, workspaceId, pipelineId)
      if (!pipeline) throw new Error(`pipelines.reorder: pipeline ${pipelineId} not found`)
      const existing = await listStages(db, workspaceId, pipelineId)
      const live = new Set(existing.map((s) => s.id))
      if (orderedIds.length !== existing.length || !orderedIds.every((id) => live.has(id))) {
        throw new Error("pipelines.reorder: order must contain exactly the live stage ids")
      }
      for (const [position, id] of orderedIds.entries()) {
        await db
          .update(pipelineStages)
          .set({
            position,
            updatedAt: new Date(),
            ...(actorId === undefined ? {} : { updatedBy: actorId }),
          })
          .where(eq(pipelineStages.id, id as string))
      }
      return listStages(db, workspaceId, pipelineId)
    },
  }
}

export type PipelinesRepository = ReturnType<typeof createPipelinesRepository>
