import { beforeEach, describe, expect, test } from "bun:test"
import type { ServiceContext } from "../index"
import {
  captureEvents,
  createStore,
  expectAllowed,
  expectDenied,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import {
  createPipelinesService,
  type PipelineRecord,
  type PipelineStageRecord,
  type PipelinesService,
  type PipelinesStore,
} from "./index"
import type { PipelineAuditInput, PipelineListQuery } from "./types"

type StoredPipeline = BaseRecord & {
  name: string
  description: string | null
  ownerId: string | null
  status: string
  isDefault: boolean
}

type StoredStage = BaseRecord & {
  pipelineId: string
  name: string
  color: string | null
  position: number
  probability: number
  isWon: boolean
  isLost: boolean
}

function asPipeline(row: StoredPipeline): PipelineRecord {
  return row as unknown as PipelineRecord
}

function asStage(row: StoredStage): PipelineStageRecord {
  return row as unknown as PipelineStageRecord
}

function toStoredStage(input: Record<string, unknown>, seed: Partial<StoredStage>): StoredStage {
  const isWon = (input.isWon as boolean | undefined) ?? false
  const isLost = (input.isLost as boolean | undefined) ?? false
  if (isWon && isLost) throw new Error("pipelines.create: a stage cannot be both won and lost")
  return {
    ...makeBaseRecord({ workspaceId: seed.workspaceId ?? "" }),
    ...seed,
    pipelineId: seed.pipelineId ?? "",
    name: input.name as string,
    color: (input.color as string | null) ?? null,
    position: seed.position ?? 0,
    probability: (input.probability as number | undefined) ?? 0,
    isWon,
    isLost,
  } as StoredStage
}

/** Hermetic PipelinesStore port backed by the shared in-memory stores. */
function makeStore() {
  const pipelines = createStore<StoredPipeline>()
  const stages = createStore<StoredStage>()

  const liveStages = (workspaceId: string, pipelineId: string) =>
    stages
      .list(workspaceId)
      .filter((s) => s.pipelineId === pipelineId)
      .sort((a, b) => a.position - b.position)

  const store: PipelinesStore = {
    list: async (workspaceId: string, query: PipelineListQuery) => {
      let rows = pipelines.list(workspaceId)
      if (query.status) rows = rows.filter((r) => r.status === query.status)
      if (query.query) {
        const q = query.query.toLowerCase()
        rows = rows.filter((r) => r.name.toLowerCase().includes(q))
      }
      const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
      const data = rows.slice(0, limit)
      return {
        data: data.map(asPipeline),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    findById: async (workspaceId: string, id: string) => {
      const row = pipelines.get(id, workspaceId)
      return row ? asPipeline(row) : null
    },
    findWithStages: async (workspaceId: string, id: string) => {
      const row = pipelines.get(id, workspaceId)
      if (!row) return null
      return { pipeline: asPipeline(row), stages: liveStages(workspaceId, id).map(asStage) }
    },
    create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
      const record: StoredPipeline = {
        ...makeBaseRecord({ workspaceId }),
        name: input.name as string,
        description: (input.description as string | null) ?? null,
        ownerId: (input.ownerId as string | null) ?? null,
        status: (input.status as string | null) ?? "active",
        isDefault: (input.isDefault as boolean | undefined) ?? false,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      }
      const pipeline = pipelines.insert(record)
      const createdStages: StoredStage[] = []
      for (const [index, item] of ((input.stages as Record<string, unknown>[]) ?? []).entries()) {
        createdStages.push(
          stages.insert(
            toStoredStage(item, { workspaceId, pipelineId: pipeline.id, position: index }),
          ),
        )
      }
      return {
        pipeline: asPipeline(pipeline),
        stages: createdStages.map(asStage),
      }
    },
    createDefault: async (workspaceId: string, actorId?: string) => {
      return store.create(
        workspaceId,
        {
          name: "Sales Pipeline",
          isDefault: true,
          stages: [{ name: "Prospecting" }, { name: "Closed Won", isWon: true }],
        },
        actorId,
      )
    },
    update: async (
      workspaceId: string,
      id: string,
      input: Record<string, unknown>,
      _actorId?: string,
    ) => {
      const row = pipelines.update(id, workspaceId, input as Partial<StoredPipeline>)
      return row ? asPipeline(row) : null
    },
    softDelete: async (workspaceId: string, id: string) => {
      pipelines.remove(id, workspaceId)
    },
    restore: async (workspaceId: string, id: string) => {
      pipelines.restore(id, workspaceId)
    },
    addStage: async (
      workspaceId: string,
      pipelineId: string,
      input: Record<string, unknown>,
      _actorId?: string,
    ) => {
      const pipeline = pipelines.get(pipelineId, workspaceId)
      if (!pipeline) return null
      const position = liveStages(workspaceId, pipelineId).length
      return asStage(stages.insert(toStoredStage(input, { workspaceId, pipelineId, position })))
    },
    updateStage: async (
      workspaceId: string,
      pipelineId: string,
      stageId: string,
      input: Record<string, unknown>,
      _actorId?: string,
    ) => {
      const row = stages.get(stageId, workspaceId)
      if (!row || row.pipelineId !== pipelineId) return null
      const merged = { ...row, ...(input as Partial<StoredStage>) }
      if (merged.isWon && merged.isLost) {
        throw new Error("pipelines.create: a stage cannot be both won and lost")
      }
      const updated = stages.update(stageId, workspaceId, input as Partial<StoredStage>)
      return updated ? asStage(updated) : null
    },
    removeStage: async (workspaceId: string, pipelineId: string, stageId: string) => {
      const row = stages.get(stageId, workspaceId)
      if (!row || row.pipelineId !== pipelineId) return false
      stages.remove(stageId, workspaceId)
      return true
    },
    reorderStages: async (
      workspaceId: string,
      pipelineId: string,
      orderedIds: string[],
      _actorId?: string,
    ) => {
      const live = liveStages(workspaceId, pipelineId)
      if (orderedIds.length !== live.length) throw new Error("pipelines.reorder: bad order")
      for (const [position, id] of orderedIds.entries()) {
        stages.update(id as string, workspaceId, { position })
      }
      return liveStages(workspaceId, pipelineId).map(asStage)
    },
  }
  return { pipelines, stages, store }
}

function setup(
  role: "owner" | "admin" | "member" | "viewer" = "owner",
  shared?: ReturnType<typeof makeStore>,
  workspaceId?: string,
) {
  const session = makeSession({ role, ...(workspaceId === undefined ? {} : { workspaceId }) })
  const ctx = makeServiceContext({ session })
  const audits: PipelineAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createPipelinesService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seed(service: PipelinesService, ctx: ServiceContext, name = "Sales") {
  return service.create(ctx, {
    name,
    stages: [
      { name: "Prospecting", probability: 10 },
      { name: "Closed Won", probability: 100, isWon: true },
    ],
  })
}

describe("pipelines/service", () => {
  test("create validates, emits pipeline.created and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const created = await expectAllowed(() => service.create(ctx, { name: "Sales" }))
      expect(created.pipeline.name).toBe("Sales")
      expect(created.stages).toEqual([])
      events.expectEmitted("pipeline.created", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "pipeline",
        entityId: created.pipeline.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "pipeline",
        recordId: created.pipeline.id,
      })
      expect(audits[0]?.after).toMatchObject({ pipeline: { name: "Sales" } })
    } finally {
      events.release()
    }
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.create(ctx, { name: "  " })).rejects.toThrow()
  })

  test("create rejects a stage that is both won and lost", async () => {
    const { ctx, service } = setup()
    await expect(
      service.create(ctx, { name: "Sales", stages: [{ name: "X", isWon: true, isLost: true }] }),
    ).rejects.toThrow(/both won and lost/)
  })

  test("get returns the pipeline with ordered stages, list paginates", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const found = await expectAllowed(() => service.get(ctx, created.pipeline.id))
    expect(found.pipeline.id).toBe(created.pipeline.id)
    expect(found.stages.map((s) => s.name)).toEqual(["Prospecting", "Closed Won"])
    const listed = await expectAllowed(() => service.list(ctx, { limit: 25 }))
    expect(listed.data).toHaveLength(1)
    expect(listed.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get throws NOT_FOUND for unknown ids", async () => {
    const { ctx, service } = setup()
    const err = await service.get(ctx, "missing").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe("NOT_FOUND")
  })

  test("update emits pipeline.updated and audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const updated = await expectAllowed(() =>
        service.update(ctx, created.pipeline.id, { description: "Q3 push" }),
      )
      expect(updated.description).toBe("Q3 push")
      const emitted = events.expectEmitted("pipeline.updated", {
        entityId: created.pipeline.id,
      })
      expect(emitted.before).toMatchObject({ name: "Sales" })
      expect(emitted.after).toMatchObject({ description: "Q3 push" })
      expect(audits.at(-1)).toMatchObject({ action: "update", recordId: created.pipeline.id })
    } finally {
      events.release()
    }
  })

  test("stage CRUD round-trips through the pipeline", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const id = created.pipeline.id
    const stage = await expectAllowed(() =>
      service.addStage(ctx, id, { name: "Negotiation", probability: 80 }),
    )
    expect(stage.probability).toBe(80)
    const updated = await expectAllowed(() =>
      service.updateStage(ctx, id, stage.id, { probability: 90 }),
    )
    expect(updated.probability).toBe(90)
    await expectAllowed(() => service.removeStage(ctx, id, stage.id))
    const found = await expectAllowed(() => service.get(ctx, id))
    expect(found.stages.map((s) => s.id)).not.toContain(stage.id)
  })

  test("reorderStages persists the new order and emits pipeline.stage_reordered", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const id = created.pipeline.id
    const events = captureEvents()
    try {
      const reversed = [...created.stages.map((s) => s.id)].reverse()
      const stages = await expectAllowed(() => service.reorderStages(ctx, id, { order: reversed }))
      expect(stages.map((s) => s.id)).toEqual(reversed)
      events.expectEmitted("pipeline.stage_reordered", { entityId: id })
    } finally {
      events.release()
    }
  })

  test("ensureDefault seeds the default pipeline once", async () => {
    const { ctx, service } = setup()
    const first = await expectAllowed(() => service.ensureDefault(ctx))
    expect(first.pipeline.name).toBe("Sales Pipeline")
    const second = await expectAllowed(() => service.ensureDefault(ctx))
    expect(second.pipeline.id).toBe(first.pipeline.id)
    const listed = await expectAllowed(() => service.list(ctx, {}))
    expect(listed.data).toHaveLength(1)
  })

  test("softDelete hides the row; restore revives it", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    await expectAllowed(() => service.softDelete(ctx, created.pipeline.id))
    await expect(service.get(ctx, created.pipeline.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
    const restored = await expectAllowed(() => service.restore(ctx, created.pipeline.id))
    expect(restored.id).toBe(created.pipeline.id)
    await expectAllowed(() => service.get(ctx, created.pipeline.id))
  })

  describe("denials", () => {
    let backing: ReturnType<typeof makeStore>
    let workspaceId: string
    let pipelineId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      pipelineId = (await seed(owner.service, owner.ctx)).pipeline.id
    })

    test("viewer cannot create", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.create(ctx, { name: "Nope" }))
    })

    test("viewer cannot update", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.update(ctx, pipelineId, { name: "X" }))
    })

    test("member cannot delete (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDelete(ctx, pipelineId))
    })

    test("viewer cannot reorder stages", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.reorderStages(ctx, pipelineId, { order: ["a"] }))
    })

    test("viewer can still list and get (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectAllowed(() => service.list(ctx, {}))
      await expectAllowed(() => service.get(ctx, pipelineId))
    })
  })
})
