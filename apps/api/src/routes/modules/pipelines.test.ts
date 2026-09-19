import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createPipelinesService, type PipelinesService } from "@yourcrm/crm/src/pipelines"
import type {
  PipelineRecord,
  PipelineStageRecord,
  PipelinesStore,
} from "@yourcrm/crm/src/pipelines"
import {
  createApiClient,
  createStore,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./pipelines"

type StoredPipeline = BaseRecord & { name: string; description: string | null; status: string }
type StoredStage = BaseRecord & {
  pipelineId: string
  name: string
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

/** Real domain service over a hermetic in-memory store. */
function makeFakeService() {
  const pipelines = createStore<StoredPipeline>()
  const stages = createStore<StoredStage>()
  const liveStages = (workspaceId: string, pipelineId: string) =>
    stages
      .list(workspaceId)
      .filter((s) => s.pipelineId === pipelineId)
      .sort((a, b) => a.position - b.position)
  const store: PipelinesStore = {
    list: async (workspaceId, query) => {
      const rows = pipelines.list(workspaceId)
      const limit = query.limit ?? 25
      const data = rows.slice(0, limit)
      return {
        data: data.map(asPipeline),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    findById: async (workspaceId, id) => {
      const row = pipelines.get(id, workspaceId)
      return row ? asPipeline(row) : null
    },
    findWithStages: async (workspaceId, id) => {
      const row = pipelines.get(id, workspaceId)
      if (!row) return null
      return { pipeline: asPipeline(row), stages: liveStages(workspaceId, id).map(asStage) }
    },
    create: async (workspaceId, input, actorId) => {
      const pipeline = pipelines.insert({
        ...makeBaseRecord({ workspaceId }),
        name: input.name as string,
        description: null,
        status: "active",
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      })
      const created: StoredStage[] = []
      for (const [index, item] of ((input.stages as Record<string, unknown>[]) ?? []).entries()) {
        created.push(
          stages.insert({
            ...makeBaseRecord({ workspaceId }),
            pipelineId: pipeline.id,
            name: item.name as string,
            position: index,
            probability: (item.probability as number | undefined) ?? 0,
            isWon: (item.isWon as boolean | undefined) ?? false,
            isLost: (item.isLost as boolean | undefined) ?? false,
          }),
        )
      }
      return { pipeline: asPipeline(pipeline), stages: created.map(asStage) }
    },
    createDefault: async (workspaceId, actorId) => {
      return store.create(workspaceId, { name: "Sales Pipeline", stages: [] }, actorId)
    },
    update: async (workspaceId, id, input) => {
      const row = pipelines.update(id, workspaceId, input as Partial<StoredPipeline>)
      return row ? asPipeline(row) : null
    },
    softDelete: async (workspaceId, id) => {
      pipelines.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      pipelines.restore(id, workspaceId)
    },
    addStage: async (workspaceId, pipelineId, input) => {
      const pipeline = pipelines.get(pipelineId, workspaceId)
      if (!pipeline) return null
      return asStage(
        stages.insert({
          ...makeBaseRecord({ workspaceId }),
          pipelineId,
          name: input.name as string,
          position: liveStages(workspaceId, pipelineId).length,
          probability: (input.probability as number | undefined) ?? 0,
          isWon: (input.isWon as boolean | undefined) ?? false,
          isLost: (input.isLost as boolean | undefined) ?? false,
        }),
      )
    },
    updateStage: async (workspaceId, pipelineId, stageId, input) => {
      const row = stages.get(stageId, workspaceId)
      if (!row || row.pipelineId !== pipelineId) return null
      const updated = stages.update(stageId, workspaceId, input as Partial<StoredStage>)
      return updated ? asStage(updated) : null
    },
    removeStage: async (workspaceId, pipelineId, stageId) => {
      const row = stages.get(stageId, workspaceId)
      if (!row || row.pipelineId !== pipelineId) return false
      stages.remove(stageId, workspaceId)
      return true
    },
    reorderStages: async (workspaceId, pipelineId, orderedIds) => {
      for (const [position, id] of orderedIds.entries()) {
        stages.update(id as string, workspaceId, { position })
      }
      return liveStages(workspaceId, pipelineId).map(asStage)
    },
  }
  return createPipelinesService({ store, audit: async () => undefined })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over an in-memory store. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: PipelinesService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/pipelines", createRoutes({ service }))
  return app
}

describe("api/pipelines", () => {
  let session: { current: Session | null }
  let service: PipelinesService
  let ctx: ReturnType<typeof makeServiceContext>

  beforeEach(() => {
    const owner = makeSession({ role: "owner" })
    ctx = makeServiceContext({ session: owner })
    session = { current: owner }
    service = makeFakeService()
  })

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/pipelines")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope", async () => {
    await service.create(ctx, { name: "Sales" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/pipelines")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get returns the pipeline with stages; unknown id is NOT_FOUND", async () => {
    const created = await service.create(ctx, {
      name: "Sales",
      stages: [{ name: "Prospecting" }],
    })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/pipelines/${created.pipeline.id}`)
    expect(ok.status).toBe(200)
    const data = ok.expectSuccess().data as { id: string; stages: unknown[] }
    expect(data.id).toBe(created.pipeline.id)
    expect(data.stages).toHaveLength(1)
    const missing = await api.get("/api/v1/pipelines/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/pipelines", { name: "  " })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const wonAndLost = await api.post("/api/v1/pipelines", {
      name: "Sales",
      stages: [{ name: "X", isWon: true, isLost: true }],
    })
    expect(wonAndLost.status).toBe(400)
    wonAndLost.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/pipelines", {
      name: "Sales",
      stages: [{ name: "Prospecting", probability: 10 }],
    })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { name: string }).name).toBe("Sales")
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/pipelines", { name: "Nope" })
    expect(res.status).toBe(403)
    const err = res.expectError("FORBIDDEN")
    expect(err.error.message).toContain("create")
  })

  test("update, delete and restore round-trip", async () => {
    const created = await service.create(ctx, { name: "Sales" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/pipelines/${created.pipeline.id}`, {
      description: "Q3",
    })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/pipelines/${created.pipeline.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/pipelines/${created.pipeline.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/pipelines/${created.pipeline.id}/restore`)
    expect(restored.status).toBe(200)
    const back = await api.get(`/api/v1/pipelines/${created.pipeline.id}`)
    expect(back.status).toBe(200)
  })

  test("stage endpoints add, update, reorder and remove", async () => {
    const created = await service.create(ctx, {
      name: "Sales",
      stages: [{ name: "A" }, { name: "B" }],
    })
    const id = created.pipeline.id
    const api = createApiClient({ app: makeTestApp(session, service) })
    const added = await api.post(`/api/v1/pipelines/${id}/stages`, { name: "C" })
    expect(added.status).toBe(201)
    const stageId = (added.expectSuccess().data as { id: string }).id
    const patched = await api.patch(`/api/v1/pipelines/${id}/stages/${stageId}`, {
      probability: 55,
    })
    expect(patched.status).toBe(200)
    expect((patched.expectSuccess().data as { probability: number }).probability).toBe(55)
    const order = [stageId, ...created.stages.map((s) => s.id)]
    const reordered = await api.post(`/api/v1/pipelines/${id}/stages/reorder`, { order })
    expect(reordered.status).toBe(200)
    expect((reordered.expectSuccess().data as { id: string }[]).map((s) => s.id)).toEqual(order)
    const removed = await api.delete(`/api/v1/pipelines/${id}/stages/${stageId}`)
    expect(removed.status).toBe(200)
    const detail = await api.get(`/api/v1/pipelines/${id}`)
    expect((detail.expectSuccess().data as { stages: unknown[] }).stages).toHaveLength(2)
  })
})
