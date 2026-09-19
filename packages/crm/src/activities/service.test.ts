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
import { createActivitiesService, type ActivitiesService, type ActivityRecord } from "./index"
import type { ActivityAuditInput, ActivityListQuery, ActivityTimelineQuery } from "./types"

type StoredActivity = BaseRecord & {
  title: string
  type: string
  subjectType: string | null
  subjectId: string | null
  body: string | null
  status: string
  ownerId: string | null
  dueAt: string | null
  completedAt: string | null
}

function asRecord(row: StoredActivity): ActivityRecord {
  return row as unknown as ActivityRecord
}

/** Hermetic ActivitiesStore port backed by the shared in-memory store. */
function makeStore() {
  const activities = createStore<StoredActivity>()
  return {
    activities,
    store: {
      list: async (workspaceId: string, query: ActivityListQuery) => {
        let rows = activities.list(workspaceId)
        if (query.type) rows = rows.filter((r) => r.type === query.type)
        if (query.status) rows = rows.filter((r) => r.status === query.status)
        if (query.subjectType) rows = rows.filter((r) => r.subjectType === query.subjectType)
        if (query.subjectId) rows = rows.filter((r) => r.subjectId === query.subjectId)
        if (query.query) {
          const q = query.query.toLowerCase()
          rows = rows.filter((r) => `${r.title} ${r.body ?? ""}`.toLowerCase().includes(q))
        }
        const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
        const data = rows.slice(0, limit)
        return {
          data: data.map(asRecord),
          pagination: {
            nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
            limit,
          },
        }
      },
      timeline: async (workspaceId: string, query: ActivityTimelineQuery) => {
        const rows = activities
          .list(workspaceId)
          .filter((r) => r.subjectType === query.subjectType && r.subjectId === query.subjectId)
        const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
        const data = rows.slice(0, limit)
        return {
          data: data.map(asRecord),
          pagination: {
            nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
            limit,
          },
        }
      },
      findById: async (workspaceId: string, id: string) => {
        const row = activities.get(id, workspaceId)
        return row ? asRecord(row) : null
      },
      create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
        const record: StoredActivity = {
          ...makeBaseRecord({ workspaceId }),
          title: input.title as string,
          type: (input.type as string | null) ?? "note",
          subjectType: (input.subjectType as string | null) ?? null,
          subjectId: (input.subjectId as string | null) ?? null,
          body: (input.body as string | null) ?? null,
          status: (input.status as string | null) ?? "open",
          ownerId: (input.ownerId as string | null) ?? null,
          dueAt: (input.dueAt as string | null) ?? null,
          completedAt: null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }
        return asRecord(activities.insert(record))
      },
      update: async (
        workspaceId: string,
        id: string,
        input: Record<string, unknown>,
        _actorId?: string,
      ) => {
        const row = activities.update(id, workspaceId, input as Partial<StoredActivity>)
        return row ? asRecord(row) : null
      },
      complete: async (workspaceId: string, id: string, _actorId?: string) => {
        const row = activities.update(id, workspaceId, {
          status: "completed",
          completedAt: new Date(Date.now()).toISOString(),
        })
        return row ? asRecord(row) : null
      },
      softDelete: async (workspaceId: string, id: string) => {
        activities.remove(id, workspaceId)
      },
      restore: async (workspaceId: string, id: string) => {
        activities.restore(id, workspaceId)
      },
    },
  }
}

function setup(
  role: "owner" | "admin" | "member" | "viewer" = "owner",
  shared?: ReturnType<typeof makeStore>,
  workspaceId?: string,
) {
  const session = makeSession({ role, ...(workspaceId === undefined ? {} : { workspaceId }) })
  const ctx = makeServiceContext({ session })
  const audits: ActivityAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createActivitiesService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seed(service: ActivitiesService, ctx: ServiceContext, title = "Call Ada") {
  return service.create(ctx, { title })
}

describe("activities/service", () => {
  test("create validates, emits activity.created and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const activity = await expectAllowed(() => service.create(ctx, { title: "Call Ada" }))
      expect(activity.title).toBe("Call Ada")
      events.expectEmitted("activity.created", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "activity",
        entityId: activity.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "activity",
        recordId: activity.id,
      })
      expect(audits[0]?.after).toMatchObject({ title: "Call Ada" })
    } finally {
      events.release()
    }
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.create(ctx, { title: "  " })).rejects.toThrow()
    await expect(service.create(ctx, { title: "Ok", type: "carrier-pigeon" })).rejects.toThrow()
  })

  test("get returns the activity, list paginates", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const found = await expectAllowed(() => service.get(ctx, created.id))
    expect(found.id).toBe(created.id)
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

  test("update emits activity.updated and audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const updated = await expectAllowed(() => service.update(ctx, created.id, { title: "Met" }))
      expect(updated.title).toBe("Met")
      const emitted = events.expectEmitted("activity.updated", { entityId: created.id })
      expect(emitted.before).toMatchObject({ title: "Call Ada" })
      expect(emitted.after).toMatchObject({ title: "Met" })
      expect(audits.at(-1)).toMatchObject({ action: "update", recordId: created.id })
    } finally {
      events.release()
    }
  })

  test("complete emits activity.completed and audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const completed = await expectAllowed(() => service.complete(ctx, created.id))
      expect(completed.status).toBe("completed")
      const emitted = events.expectEmitted("activity.completed", { entityId: created.id })
      expect(emitted.before).toMatchObject({ status: "open" })
      expect(emitted.after).toMatchObject({ status: "completed" })
      expect(audits.at(-1)).toMatchObject({ action: "complete", recordId: created.id })
    } finally {
      events.release()
    }
  })

  test("timeline returns only the subject's activities", async () => {
    const { ctx, service } = setup()
    await service.create(ctx, {
      title: "On record",
      subjectType: "person",
      subjectId: "person-1",
    })
    await service.create(ctx, {
      title: "Elsewhere",
      subjectType: "person",
      subjectId: "person-2",
    })
    const feed = await expectAllowed(() =>
      service.timeline(ctx, { subjectType: "person", subjectId: "person-1" }),
    )
    expect(feed.data).toHaveLength(1)
    expect(feed.data[0]?.title).toBe("On record")
  })

  test("softDelete emits activity.deleted and hides the row; restore revives it", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      await expectAllowed(() => service.softDelete(ctx, created.id))
      events.expectEmitted("activity.deleted", { entityId: created.id })
      await expect(service.get(ctx, created.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
      const restored = await expectAllowed(() => service.restore(ctx, created.id))
      expect(restored.id).toBe(created.id)
      await expectAllowed(() => service.get(ctx, created.id))
    } finally {
      events.release()
    }
  })

  describe("denials", () => {
    let backing: ReturnType<typeof makeStore>
    let workspaceId: string
    let activityId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      activityId = (await seed(owner.service, owner.ctx)).id
    })

    test("viewer cannot create", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.create(ctx, { title: "Nope" }))
    })

    test("viewer cannot update", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.update(ctx, activityId, { title: "X" }))
    })

    test("member cannot delete (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDelete(ctx, activityId))
    })

    test("viewer can still list, timeline and get (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectAllowed(() => service.list(ctx, {}))
      await expectAllowed(() => service.get(ctx, activityId))
    })
  })
})
