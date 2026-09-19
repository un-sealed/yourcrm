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
import { createLeadsService, type LeadsService, type LeadRecord } from "./index"
import type { LeadAuditInput, LeadListQuery } from "./types"

type StoredLead = BaseRecord & {
  firstName: string
  lastName: string | null
  email: string | null
  phone: string | null
  companyName: string | null
  title: string | null
  source: string
  status: string
  score: number
  ownerId: string | null
  notes: string | null
  personId: string | null
  companyId: string | null
  dealId: string | null
}

function asRecord(row: StoredLead): LeadRecord {
  return row as unknown as LeadRecord
}

/** Hermetic LeadsStore port backed by the shared in-memory store. */
function makeStore() {
  const leads = createStore<StoredLead>()
  return {
    leads,
    store: {
      list: async (workspaceId: string, query: LeadListQuery) => {
        let rows = leads.list(workspaceId)
        if (query.status) rows = rows.filter((r) => r.status === query.status)
        if (query.source) rows = rows.filter((r) => r.source === query.source)
        if (query.query) {
          const q = query.query.toLowerCase()
          rows = rows.filter((r) =>
            `${r.firstName} ${r.lastName ?? ""} ${r.email ?? ""} ${r.companyName ?? ""}`
              .toLowerCase()
              .includes(q),
          )
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
        const row = leads.get(id, workspaceId)
        return row ? asRecord(row) : null
      },
      create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
        const record: StoredLead = {
          ...makeBaseRecord({ workspaceId }),
          firstName: input.firstName as string,
          lastName: (input.lastName as string | null) ?? null,
          email: (input.email as string | null) ?? null,
          phone: (input.phone as string | null) ?? null,
          companyName: (input.companyName as string | null) ?? null,
          title: (input.title as string | null) ?? null,
          source: (input.source as string | null) ?? "manual",
          status: (input.status as string | null) ?? "new",
          score: (input.score as number | null) ?? 0,
          ownerId: (input.ownerId as string | null) ?? null,
          notes: (input.notes as string | null) ?? null,
          personId: (input.personId as string | null) ?? null,
          companyId: (input.companyId as string | null) ?? null,
          dealId: (input.dealId as string | null) ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }
        return asRecord(leads.insert(record))
      },
      update: async (
        workspaceId: string,
        id: string,
        input: Record<string, unknown>,
        _actorId?: string,
      ) => {
        const row = leads.update(id, workspaceId, input as Partial<StoredLead>)
        return row ? asRecord(row) : null
      },
      softDelete: async (workspaceId: string, id: string) => {
        leads.remove(id, workspaceId)
      },
      restore: async (workspaceId: string, id: string) => {
        leads.restore(id, workspaceId)
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
  const audits: LeadAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createLeadsService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seed(service: LeadsService, ctx: ServiceContext, firstName = "Ada") {
  return service.create(ctx, { firstName })
}

describe("leads/service", () => {
  test("create validates, emits lead.created and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const lead = await expectAllowed(() => service.create(ctx, { firstName: "Ada" }))
      expect(lead.firstName).toBe("Ada")
      events.expectEmitted("lead.created", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "lead",
        entityId: lead.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "lead",
        recordId: lead.id,
      })
      expect(audits[0]?.after).toMatchObject({ firstName: "Ada" })
    } finally {
      events.release()
    }
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.create(ctx, { firstName: "  " })).rejects.toThrow()
    await expect(service.create(ctx, { firstName: "Ada", score: 101 })).rejects.toThrow()
    await expect(service.create(ctx, { firstName: "Ada", status: "vip" })).rejects.toThrow()
  })

  test("get returns the lead, list paginates and filters", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const found = await expectAllowed(() => service.get(ctx, created.id))
    expect(found.id).toBe(created.id)
    const listed = await expectAllowed(() => service.list(ctx, { limit: 25 }))
    expect(listed.data).toHaveLength(1)
    expect(listed.pagination).toEqual({ nextCursor: null, limit: 25 })
    const filtered = await expectAllowed(() => service.list(ctx, { status: "working" }))
    expect(filtered.data).toHaveLength(0)
  })

  test("get throws NOT_FOUND for unknown ids", async () => {
    const { ctx, service } = setup()
    const err = await service.get(ctx, "missing").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe("NOT_FOUND")
  })

  test("update emits lead.updated and audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const updated = await expectAllowed(() => service.update(ctx, created.id, { score: 42 }))
      expect(updated.score).toBe(42)
      const emitted = events.expectEmitted("lead.updated", { entityId: created.id })
      expect(emitted.before).toMatchObject({ score: 0 })
      expect(emitted.after).toMatchObject({ score: 42 })
      expect(audits.at(-1)).toMatchObject({ action: "update", recordId: created.id })
    } finally {
      events.release()
    }
  })

  test("qualify flips status and emits lead.qualified", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const qualified = await expectAllowed(() => service.qualify(ctx, created.id))
      expect(qualified.status).toBe("qualified")
      const emitted = events.expectEmitted("lead.qualified", { entityId: created.id })
      expect(emitted.before).toMatchObject({ status: "new" })
      expect(emitted.after).toMatchObject({ status: "qualified" })
      expect(audits.at(-1)).toMatchObject({ action: "qualify", recordId: created.id })
    } finally {
      events.release()
    }
  })

  test("convert stores target ids, flips status and emits lead.converted", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const converted = await expectAllowed(() =>
        service.convert(ctx, created.id, { personId: "person_1", dealId: "deal_1" }),
      )
      expect(converted.status).toBe("converted")
      expect(converted.personId).toBe("person_1")
      expect(converted.dealId).toBe("deal_1")
      const emitted = events.expectEmitted("lead.converted", { entityId: created.id })
      expect(emitted.after).toMatchObject({ status: "converted", personId: "person_1" })
      expect(audits.at(-1)).toMatchObject({ action: "convert", recordId: created.id })
    } finally {
      events.release()
    }
  })

  test("softDelete emits lead.deleted and hides the row; restore revives it", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      await expectAllowed(() => service.softDelete(ctx, created.id))
      events.expectEmitted("lead.deleted", { entityId: created.id })
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
    let leadId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      leadId = (await seed(owner.service, owner.ctx)).id
    })

    test("viewer cannot create", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.create(ctx, { firstName: "Nope" }))
    })

    test("viewer cannot update", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.update(ctx, leadId, { score: 10 }))
    })

    test("viewer cannot qualify or convert", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.qualify(ctx, leadId))
      await expectDenied(() => service.convert(ctx, leadId, {}))
    })

    test("member cannot delete (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDelete(ctx, leadId))
    })

    test("viewer can still list and get (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectAllowed(() => service.list(ctx, {}))
      await expectAllowed(() => service.get(ctx, leadId))
    })
  })
})
