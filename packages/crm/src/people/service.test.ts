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
  createPeopleService,
  type PeopleService,
  type PersonContact,
  type PersonRecord,
} from "./index"
import type { PersonAuditInput, PersonListQuery } from "./types"

type StoredPerson = BaseRecord & {
  firstName: string
  lastName: string | null
  title: string | null
  companyId: string | null
  ownerId: string | null
  status: string
  preferredChannel: string | null
  notes: string | null
}

function asRecord(row: StoredPerson): PersonRecord {
  return row as unknown as PersonRecord
}

/** Hermetic PeopleStore port backed by the shared in-memory store. */
function makeStore() {
  const people = createStore<StoredPerson>()
  const emails: PersonContact[] = []
  const phones: PersonContact[] = []
  return {
    people,
    store: {
      list: async (workspaceId: string, query: PersonListQuery) => {
        let rows = people.list(workspaceId)
        if (query.status) rows = rows.filter((r) => r.status === query.status)
        if (query.query) {
          const q = query.query.toLowerCase()
          rows = rows.filter((r) => `${r.firstName} ${r.lastName ?? ""}`.toLowerCase().includes(q))
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
        const row = people.get(id, workspaceId)
        return row ? asRecord(row) : null
      },
      findWithContacts: async (workspaceId: string, id: string) => {
        const row = people.get(id, workspaceId)
        if (!row) return null
        return {
          person: asRecord(row),
          emails: emails.filter((e) => e.personId === id),
          phones: phones.filter((p) => p.personId === id),
        }
      },
      create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
        const record: StoredPerson = {
          ...makeBaseRecord({ workspaceId }),
          firstName: input.firstName as string,
          lastName: (input.lastName as string | null) ?? null,
          title: (input.title as string | null) ?? null,
          companyId: (input.companyId as string | null) ?? null,
          ownerId: (input.ownerId as string | null) ?? null,
          status: (input.status as string | null) ?? "active",
          preferredChannel: (input.preferredChannel as string | null) ?? null,
          notes: (input.notes as string | null) ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }
        return asRecord(people.insert(record))
      },
      update: async (
        workspaceId: string,
        id: string,
        input: Record<string, unknown>,
        _actorId?: string,
      ) => {
        const row = people.update(id, workspaceId, input as Partial<StoredPerson>)
        return row ? asRecord(row) : null
      },
      softDelete: async (workspaceId: string, id: string) => {
        people.remove(id, workspaceId)
      },
      restore: async (workspaceId: string, id: string) => {
        people.restore(id, workspaceId)
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
  const audits: PersonAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createPeopleService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seed(service: PeopleService, ctx: ServiceContext, firstName = "Ada") {
  return service.create(ctx, { firstName })
}

describe("people/service", () => {
  test("create validates, emits person.created and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const person = await expectAllowed(() => service.create(ctx, { firstName: "Ada" }))
      expect(person.firstName).toBe("Ada")
      events.expectEmitted("person.created", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "person",
        entityId: person.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "person",
        recordId: person.id,
      })
      expect(audits[0]?.after).toMatchObject({ firstName: "Ada" })
    } finally {
      events.release()
    }
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.create(ctx, { firstName: "  " })).rejects.toThrow()
  })

  test("get returns the person with contacts, list paginates", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const found = await expectAllowed(() => service.get(ctx, created.id))
    expect(found.person.id).toBe(created.id)
    expect(found.emails).toEqual([])
    expect(found.phones).toEqual([])
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

  test("update emits person.updated and audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const updated = await expectAllowed(() => service.update(ctx, created.id, { title: "CTO" }))
      expect(updated.title).toBe("CTO")
      const emitted = events.expectEmitted("person.updated", { entityId: created.id })
      expect(emitted.before).toMatchObject({ title: null })
      expect(emitted.after).toMatchObject({ title: "CTO" })
      expect(audits.at(-1)).toMatchObject({ action: "update", recordId: created.id })
    } finally {
      events.release()
    }
  })

  test("softDelete emits person.deleted and hides the row; restore revives it", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      await expectAllowed(() => service.softDelete(ctx, created.id))
      events.expectEmitted("person.deleted", { entityId: created.id })
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
    let personId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      personId = (await seed(owner.service, owner.ctx)).id
    })

    test("viewer cannot create", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.create(ctx, { firstName: "Nope" }))
    })

    test("viewer cannot update", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.update(ctx, personId, { title: "X" }))
    })

    test("member cannot delete (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDelete(ctx, personId))
    })

    test("viewer can still list and get (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectAllowed(() => service.list(ctx, {}))
      await expectAllowed(() => service.get(ctx, personId))
    })
  })
})
