import { beforeEach, describe, expect, test } from "bun:test"
import type { ServiceContext } from "../index"
import {
  captureEvents,
  createStore,
  expectAllowed,
  expectDenied,
  freezeTime,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
  nextId,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { createNotificationsService, type NotificationsService } from "./index"
import type {
  AppNotification,
  NotificationAuditInput,
  NotificationPreferenceRecord,
  NotificationPreferencesStore,
  NotificationsStore,
} from "./types"

type StoredNotification = BaseRecord & {
  userId: string
  type: string
  title: string
  body: string | null
  readAt: string | null
}

function asNotification(row: StoredNotification): AppNotification {
  return row as unknown as AppNotification
}

/** Hermetic NotificationsStore port backed by the shared in-memory store, with explicit user scoping. */
function makeNotificationsStore() {
  const rows = createStore<StoredNotification>()
  const store: NotificationsStore = {
    list: async (workspaceId, userId, query) => {
      let all = rows.list(workspaceId).filter((r) => r.userId === userId)
      if (query.unreadOnly) all = all.filter((r) => r.readAt === null)
      all = all.slice().sort((a, b) => {
        const unreadRank = (r: StoredNotification) => (r.readAt === null ? 0 : 1)
        const rank = unreadRank(a) - unreadRank(b)
        if (rank !== 0) return rank
        return b.createdAt.localeCompare(a.createdAt)
      })
      const limit = query.limit ?? 25
      const data = all.slice(0, limit)
      return {
        data: data.map(asNotification),
        pagination: {
          nextCursor: all.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    countUnread: async (workspaceId, userId) =>
      rows.list(workspaceId).filter((r) => r.userId === userId && r.readAt === null).length,
    findById: async (workspaceId, userId, id) => {
      const row = rows.get(id, workspaceId)
      if (!row || row.userId !== userId) return null
      return asNotification(row)
    },
    create: async (workspaceId, input, actorId) => {
      const record: StoredNotification = {
        ...makeBaseRecord({ workspaceId }),
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        readAt: null,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      }
      return asNotification(rows.insert(record))
    },
    markRead: async (workspaceId, userId, id) => {
      const row = rows.get(id, workspaceId)
      if (!row || row.userId !== userId) return null
      const readAt = row.readAt ?? new Date().toISOString()
      const updated = rows.update(id, workspaceId, { readAt } as Partial<StoredNotification>)
      return updated ? asNotification(updated) : null
    },
    markAllRead: async (workspaceId, userId) => {
      const unread = rows.list(workspaceId).filter((r) => r.userId === userId && r.readAt === null)
      const readAt = new Date().toISOString()
      for (const row of unread)
        rows.update(row.id, workspaceId, { readAt } as Partial<StoredNotification>)
      return { updated: unread.length }
    },
    softDelete: async (workspaceId, userId, id) => {
      const row = rows.get(id, workspaceId)
      if (row && row.userId === userId) rows.remove(id, workspaceId)
    },
  }
  return { rows, store }
}

/** Hermetic NotificationPreferencesStore port: one row per (workspace, user). */
function makePreferencesStore() {
  const map = new Map<string, NotificationPreferenceRecord>()
  const key = (workspaceId: string, userId: string) => `${workspaceId}:${userId}`
  const store: NotificationPreferencesStore = {
    get: async (workspaceId, userId) => map.get(key(workspaceId, userId)) ?? null,
    upsert: async (workspaceId, userId, patch) => {
      const existing = map.get(key(workspaceId, userId))
      const merged: NotificationPreferenceRecord = {
        id: existing?.id ?? nextId("pref"),
        workspaceId,
        userId,
        categories: { ...(existing?.categories ?? {}), ...(patch.categories ?? {}) },
        quietHoursEnabled: patch.quietHoursEnabled ?? existing?.quietHoursEnabled ?? false,
        quietHoursStart:
          patch.quietHoursStart !== undefined
            ? patch.quietHoursStart
            : (existing?.quietHoursStart ?? null),
        quietHoursEnd:
          patch.quietHoursEnd !== undefined
            ? patch.quietHoursEnd
            : (existing?.quietHoursEnd ?? null),
        timezone: patch.timezone ?? existing?.timezone ?? "UTC",
      }
      map.set(key(workspaceId, userId), merged)
      return merged
    },
  }
  return { map, store }
}

function setup(
  role: "owner" | "admin" | "member" | "viewer" = "owner",
  shared?: {
    notifications: ReturnType<typeof makeNotificationsStore>
    preferences: ReturnType<typeof makePreferencesStore>
  },
  workspaceId?: string,
  actorId?: string,
) {
  const session = makeSession({
    role,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(actorId === undefined ? {} : { userId: actorId }),
  })
  const ctx = makeServiceContext({ session })
  const audits: NotificationAuditInput[] = []
  const backing = shared ?? {
    notifications: makeNotificationsStore(),
    preferences: makePreferencesStore(),
  }
  const service = createNotificationsService({
    store: backing.notifications.store,
    preferencesStore: backing.preferences.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seed(
  service: NotificationsService,
  ctx: ServiceContext,
  overrides: { userId?: string; type?: string; title?: string } = {},
) {
  const created = await service.create(ctx, {
    userId: overrides.userId ?? ctx.actorId,
    type: overrides.type ?? "general",
    title: overrides.title ?? "Hello",
  })
  if (!created) throw new Error("seed: notification was unexpectedly suppressed")
  return created
}

describe("notifications/service", () => {
  test("create validates, emits notification.created and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const notification = await expectAllowed(() => seed(service, ctx, { title: "Ada" }))
      expect(notification.title).toBe("Ada")
      events.expectEmitted("notification.created", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "notification",
        entityId: notification.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "notification",
        recordId: notification.id,
      })
    } finally {
      events.release()
    }
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(
      service.create(ctx, { userId: ctx.actorId, type: "general", title: "" }),
    ).rejects.toThrow()
    await expect(
      service.create(ctx, { userId: ctx.actorId, type: "not-a-real-category", title: "Hi" }),
    ).rejects.toThrow()
  })

  test("list is unread-first, get returns the notification, unknown id is NOT_FOUND", async () => {
    const { ctx, service } = setup()
    const first = await seed(service, ctx, { title: "First" })
    const second = await seed(service, ctx, { title: "Second" })
    await service.markRead(ctx, first.id)
    const listed = await expectAllowed(() => service.list(ctx, {}))
    expect(listed.data.map((n) => n.id)).toEqual([second.id, first.id])
    const found = await expectAllowed(() => service.get(ctx, second.id))
    expect(found.id).toBe(second.id)
    const err = await service.get(ctx, "missing").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe("NOT_FOUND")
  })

  describe("property: a user only ever reads their own notifications", () => {
    test("cross-user get() is NOT_FOUND, not the other user's data", async () => {
      const backing = {
        notifications: makeNotificationsStore(),
        preferences: makePreferencesStore(),
      }
      const owner = setup("owner", backing)
      const ownerNotification = await seed(owner.service, owner.ctx, { title: "For owner" })

      const otherActorId = nextId("user")
      const other = setup("member", backing, owner.ctx.workspaceId, otherActorId)
      const err = await other.service.get(other.ctx, ownerNotification.id).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as { code?: string }).code).toBe("NOT_FOUND")
    })

    test("cross-user list() never includes the other user's notifications", async () => {
      const backing = {
        notifications: makeNotificationsStore(),
        preferences: makePreferencesStore(),
      }
      const owner = setup("owner", backing)
      await seed(owner.service, owner.ctx, { title: "For owner" })

      const otherActorId = nextId("user")
      const other = setup("member", backing, owner.ctx.workspaceId, otherActorId)
      const theirList = await expectAllowed(() => other.service.list(other.ctx, {}))
      expect(theirList.data).toEqual([])
    })

    test("cross-user markRead()/delete() are NOT_FOUND, never silently succeed", async () => {
      const backing = {
        notifications: makeNotificationsStore(),
        preferences: makePreferencesStore(),
      }
      const owner = setup("owner", backing)
      const ownerNotification = await seed(owner.service, owner.ctx, { title: "For owner" })

      // Admin role so the assertion below proves ownership scoping, not the
      // permission-rank gate (member rank is already too low for "delete").
      const otherActorId = nextId("user")
      const other = setup("admin", backing, owner.ctx.workspaceId, otherActorId)
      await expect(other.service.markRead(other.ctx, ownerNotification.id)).rejects.toMatchObject({
        code: "NOT_FOUND",
      })
      await expect(other.service.softDelete(other.ctx, ownerNotification.id)).rejects.toMatchObject(
        {
          code: "NOT_FOUND",
        },
      )
      // Still there for the actual owner — nothing was mutated by the other user's calls.
      const stillThere = await expectAllowed(() =>
        owner.service.get(owner.ctx, ownerNotification.id),
      )
      expect(stillThere.id).toBe(ownerNotification.id)
    })
  })

  describe("property: preference/quiet-hours suppression happens at create() — the row is never written", () => {
    test("category disabled for in_app: create() returns null and nothing is stored", async () => {
      const { ctx, service, backing, audits } = setup()
      await backing.preferences.store.upsert(ctx.workspaceId, ctx.actorId, {
        categories: { general: { in_app: false } },
      })
      const events = captureEvents()
      try {
        const result = await service.create(ctx, {
          userId: ctx.actorId,
          type: "general",
          title: "Muted",
        })
        expect(result).toBeNull()
        const listed = await service.list(ctx, {})
        expect(listed.data).toEqual([])
        expect(audits).toHaveLength(0)
        expect(events.count("notification.created")).toBe(0)
      } finally {
        events.release()
      }
    })

    test("inside quiet hours: create() returns null and nothing is stored", async () => {
      const { ctx, service, backing, audits } = setup()
      await backing.preferences.store.upsert(ctx.workspaceId, ctx.actorId, {
        quietHoursEnabled: true,
        quietHoursStart: "22:00",
        quietHoursEnd: "07:00",
        timezone: "UTC",
      })
      // 23:00 UTC falls inside the 22:00 -> 07:00 overnight window.
      const clock = freezeTime("2026-01-01T23:00:00.000Z")
      try {
        const result = await service.create(ctx, {
          userId: ctx.actorId,
          type: "general",
          title: "Late",
        })
        expect(result).toBeNull()
        const listed = await service.list(ctx, {})
        expect(listed.data).toEqual([])
        expect(audits).toHaveLength(0)
      } finally {
        clock.restore()
      }
    })

    test("outside quiet hours: create() succeeds normally", async () => {
      const { ctx, service, backing } = setup()
      await backing.preferences.store.upsert(ctx.workspaceId, ctx.actorId, {
        quietHoursEnabled: true,
        quietHoursStart: "22:00",
        quietHoursEnd: "07:00",
        timezone: "UTC",
      })
      // 12:00 UTC is outside the overnight window.
      const clock = freezeTime("2026-01-01T12:00:00.000Z")
      try {
        const result = await service.create(ctx, {
          userId: ctx.actorId,
          type: "general",
          title: "Daytime",
        })
        expect(result).not.toBeNull()
        const listed = await service.list(ctx, {})
        expect(listed.data).toHaveLength(1)
      } finally {
        clock.restore()
      }
    })

    test("default preference (no row) allows in-app creation", async () => {
      const { ctx, service } = setup()
      const result = await service.create(ctx, {
        userId: ctx.actorId,
        type: "mention",
        title: "Hi",
      })
      expect(result).not.toBeNull()
    })
  })

  describe("property: marking read is idempotent", () => {
    test("second markRead() on the same notification is a no-op, not an error", async () => {
      const { ctx, service } = setup()
      const created = await seed(service, ctx)
      const first = await expectAllowed(() => service.markRead(ctx, created.id))
      expect(first.readAt).not.toBeNull()
      const second = await expectAllowed(() => service.markRead(ctx, created.id))
      expect(second.readAt).toBe(first.readAt)
    })

    test("markAllRead() twice: second call updates zero rows", async () => {
      const { ctx, service } = setup()
      await seed(service, ctx, { title: "One" })
      await seed(service, ctx, { title: "Two" })
      const first = await expectAllowed(() => service.markAllRead(ctx))
      expect(first.updated).toBe(2)
      const second = await expectAllowed(() => service.markAllRead(ctx))
      expect(second.updated).toBe(0)
    })
  })

  test("softDelete emits notification.deleted and hides the row", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      await expectAllowed(() => service.softDelete(ctx, created.id))
      events.expectEmitted("notification.deleted", { entityId: created.id })
      await expect(service.get(ctx, created.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
    } finally {
      events.release()
    }
  })

  test("preferences: get defaults to null (no row yet), update creates and merges categories", async () => {
    const { ctx, service, audits } = setup()
    const before = await expectAllowed(() => service.getPreferences(ctx))
    expect(before).toBeNull()

    const events = captureEvents()
    try {
      const updated = await expectAllowed(() =>
        service.updatePreferences(ctx, {
          categories: { mention: { email: true } },
          timezone: "America/New_York",
        }),
      )
      expect(updated.timezone).toBe("America/New_York")
      expect(updated.categories.mention).toMatchObject({ email: true })
      events.expectEmitted("notification.preferences_updated", { workspaceId: ctx.workspaceId })
      expect(audits.at(-1)).toMatchObject({ action: "update", object: "notification_preference" })

      const updatedAgain = await expectAllowed(() =>
        service.updatePreferences(ctx, { categories: { deal_stage: { in_app: false } } }),
      )
      // Previous category override survives a patch to a different category.
      expect(updatedAgain.categories.mention).toMatchObject({ email: true })
      expect(updatedAgain.categories.deal_stage).toMatchObject({ in_app: false })
    } finally {
      events.release()
    }
  })

  describe("denials", () => {
    let backing: {
      notifications: ReturnType<typeof makeNotificationsStore>
      preferences: ReturnType<typeof makePreferencesStore>
    }
    let workspaceId: string
    let notificationId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = { notifications: makeNotificationsStore(), preferences: makePreferencesStore() }
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      notificationId = (await seed(owner.service, owner.ctx)).id
    })

    test("viewer cannot create", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() =>
        service.create(ctx, { userId: ctx.actorId, type: "general", title: "Nope" }),
      )
    })

    test("viewer cannot mark read or delete", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.markRead(ctx, notificationId))
      await expectDenied(() => service.softDelete(ctx, notificationId))
    })

    test("member can still list, get and create their own", async () => {
      const { ctx, service } = asRole("member")
      const own = await service.create(ctx, { userId: ctx.actorId, type: "general", title: "Mine" })
      expect(own).not.toBeNull()
      await expectAllowed(() => service.list(ctx, {}))
    })
  })
})
