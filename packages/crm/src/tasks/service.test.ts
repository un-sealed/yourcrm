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
import { createTasksService, type TasksService, type TaskRecord } from "./index"
import type { TaskAuditInput, TaskListQuery } from "./types"

type StoredTask = BaseRecord & {
  title: string
  description: string | null
  status: string
  priority: string
  dueDate: string | null
  completedAt: string | null
  assigneeId: string | null
  ownerId: string | null
  personId: string | null
  companyId: string | null
  dealId: string | null
}

function asRecord(row: StoredTask): TaskRecord {
  return row as unknown as TaskRecord
}

/** Hermetic TasksStore port backed by the shared in-memory store. */
function makeStore() {
  const tasks = createStore<StoredTask>()
  return {
    tasks,
    store: {
      list: async (workspaceId: string, query: TaskListQuery) => {
        let rows = tasks.list(workspaceId)
        if (query.status) rows = rows.filter((r) => r.status === query.status)
        if (query.priority) rows = rows.filter((r) => r.priority === query.priority)
        if (query.assigneeId) rows = rows.filter((r) => r.assigneeId === query.assigneeId)
        if (query.overdue) {
          const now = Date.now()
          rows = rows.filter(
            (r) => r.status !== "completed" && r.dueDate !== null && Date.parse(r.dueDate) < now,
          )
        }
        if (query.query) {
          const q = query.query.toLowerCase()
          rows = rows.filter((r) => `${r.title} ${r.description ?? ""}`.toLowerCase().includes(q))
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
      findById: async (workspaceId: string, id: string) => {
        const row = tasks.get(id, workspaceId)
        return row ? asRecord(row) : null
      },
      create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
        const record: StoredTask = {
          ...makeBaseRecord({ workspaceId }),
          title: input.title as string,
          description: (input.description as string | null) ?? null,
          status: (input.status as string | null) ?? "open",
          priority: (input.priority as string | null) ?? "medium",
          dueDate: (input.dueDate as string | null) ?? null,
          completedAt: (input.completedAt as string | null) ?? null,
          assigneeId: (input.assigneeId as string | null) ?? null,
          ownerId: (input.ownerId as string | null) ?? null,
          personId: (input.personId as string | null) ?? null,
          companyId: (input.companyId as string | null) ?? null,
          dealId: (input.dealId as string | null) ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }
        return asRecord(tasks.insert(record))
      },
      update: async (
        workspaceId: string,
        id: string,
        input: Record<string, unknown>,
        _actorId?: string,
      ) => {
        const row = tasks.update(id, workspaceId, input as Partial<StoredTask>)
        return row ? asRecord(row) : null
      },
      softDelete: async (workspaceId: string, id: string) => {
        tasks.remove(id, workspaceId)
      },
      restore: async (workspaceId: string, id: string) => {
        tasks.restore(id, workspaceId)
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
  const audits: TaskAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createTasksService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seed(service: TasksService, ctx: ServiceContext, title = "Follow up") {
  return service.create(ctx, { title })
}

describe("tasks/service", () => {
  test("create validates, emits task.created and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const task = await expectAllowed(() => service.create(ctx, { title: "Follow up" }))
      expect(task.title).toBe("Follow up")
      events.expectEmitted("task.created", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "task",
        entityId: task.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "task",
        recordId: task.id,
      })
      expect(audits[0]?.after).toMatchObject({ title: "Follow up" })
    } finally {
      events.release()
    }
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.create(ctx, { title: "  " })).rejects.toThrow()
  })

  test("get returns the task, list paginates", async () => {
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

  test("update emits task.updated and audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const updated = await expectAllowed(() =>
        service.update(ctx, created.id, { priority: "urgent" }),
      )
      expect(updated.priority).toBe("urgent")
      const emitted = events.expectEmitted("task.updated", { entityId: created.id })
      expect(emitted.before).toMatchObject({ priority: "medium" })
      expect(emitted.after).toMatchObject({ priority: "urgent" })
      expect(audits.at(-1)).toMatchObject({ action: "update", recordId: created.id })
    } finally {
      events.release()
    }
  })

  test("complete emits task.completed; reopen emits task.updated", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const done = await expectAllowed(() => service.complete(ctx, created.id))
      expect(done.status).toBe("completed")
      events.expectEmitted("task.completed", { entityId: created.id })
      const open = await expectAllowed(() => service.reopen(ctx, created.id))
      expect(open.status).toBe("open")
      events.expectEmitted("task.updated", { entityId: created.id })
    } finally {
      events.release()
    }
  })

  test("mine scopes the list to the current actor", async () => {
    const owner = setup("owner")
    const otherCtx = makeServiceContext({
      session: makeSession({ role: "member", workspaceId: owner.ctx.workspaceId }),
    })
    await owner.service.create(owner.ctx, {
      title: "Mine",
      assigneeId: owner.ctx.actorId,
    })
    await owner.service.create(owner.ctx, { title: "Theirs" })
    const listed = await expectAllowed(() => owner.service.list(owner.ctx, { mine: true }))
    expect(listed.data).toHaveLength(1)
    expect(listed.data[0]?.title).toBe("Mine")
    const others = await expectAllowed(() => owner.service.list(otherCtx, { mine: true }))
    expect(others.data).toHaveLength(0)
  })

  test("overdue filter returns only past-due open tasks", async () => {
    const { ctx, service } = setup()
    await service.create(ctx, { title: "Late", dueDate: "2000-01-01T00:00:00.000Z" })
    await service.create(ctx, { title: "Future", dueDate: "2999-01-01T00:00:00.000Z" })
    const listed = await expectAllowed(() => service.list(ctx, { overdue: true }))
    expect(listed.data.map((t) => t.title)).toEqual(["Late"])
  })

  test("softDelete emits task.deleted and hides the row; restore revives it", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      await expectAllowed(() => service.softDelete(ctx, created.id))
      events.expectEmitted("task.deleted", { entityId: created.id })
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
    let taskId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      taskId = (await seed(owner.service, owner.ctx)).id
    })

    test("viewer cannot create", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.create(ctx, { title: "Nope" }))
    })

    test("viewer cannot update", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.update(ctx, taskId, { title: "X" }))
    })

    test("viewer cannot complete", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.complete(ctx, taskId))
    })

    test("member cannot delete (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDelete(ctx, taskId))
    })

    test("viewer can still list and get (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectAllowed(() => service.list(ctx, {}))
      await expectAllowed(() => service.get(ctx, taskId))
    })
  })
})
