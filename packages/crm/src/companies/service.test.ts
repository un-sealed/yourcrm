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
  createCompaniesService,
  type CompaniesService,
  type CompanyAddressRecord,
  type CompanyRecord,
} from "./index"
import type { CompanyAuditInput, CompanyListQuery } from "./types"

type StoredCompany = BaseRecord & {
  name: string
  domain: string | null
  website: string | null
  industry: string | null
  size: string | null
  ownerId: string | null
  parentCompanyId: string | null
  status: string
  description: string | null
}

function asRecord(row: StoredCompany): CompanyRecord {
  return row as unknown as CompanyRecord
}

/** Hermetic CompaniesStore port backed by the shared in-memory store. */
function makeStore() {
  const companies = createStore<StoredCompany>()
  const addresses: CompanyAddressRecord[] = []
  return {
    companies,
    store: {
      list: async (workspaceId: string, query: CompanyListQuery) => {
        let rows = companies.list(workspaceId)
        if (query.status) rows = rows.filter((r) => r.status === query.status)
        if (query.industry) rows = rows.filter((r) => r.industry === query.industry)
        if (query.query) {
          const q = query.query.toLowerCase()
          rows = rows.filter((r) =>
            `${r.name} ${r.domain ?? ""} ${r.industry ?? ""}`.toLowerCase().includes(q),
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
        const row = companies.get(id, workspaceId)
        return row ? asRecord(row) : null
      },
      findWithAddresses: async (workspaceId: string, id: string) => {
        const row = companies.get(id, workspaceId)
        if (!row) return null
        return {
          company: asRecord(row),
          addresses: addresses.filter((a) => a.companyId === id),
        }
      },
      listChildren: async (workspaceId: string, parentId: string) => {
        return companies
          .list(workspaceId)
          .filter((r) => r.parentCompanyId === parentId)
          .map(asRecord)
      },
      create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
        const record: StoredCompany = {
          ...makeBaseRecord({ workspaceId }),
          name: input.name as string,
          domain: (input.domain as string | null) ?? null,
          website: (input.website as string | null) ?? null,
          industry: (input.industry as string | null) ?? null,
          size: (input.size as string | null) ?? null,
          ownerId: (input.ownerId as string | null) ?? null,
          parentCompanyId: (input.parentCompanyId as string | null) ?? null,
          status: (input.status as string | null) ?? "active",
          description: (input.description as string | null) ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }
        return asRecord(companies.insert(record))
      },
      update: async (
        workspaceId: string,
        id: string,
        input: Record<string, unknown>,
        _actorId?: string,
      ) => {
        const row = companies.update(id, workspaceId, input as Partial<StoredCompany>)
        return row ? asRecord(row) : null
      },
      softDelete: async (workspaceId: string, id: string) => {
        companies.remove(id, workspaceId)
      },
      restore: async (workspaceId: string, id: string) => {
        companies.restore(id, workspaceId)
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
  const audits: CompanyAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createCompaniesService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seed(service: CompaniesService, ctx: ServiceContext, name = "Acme") {
  return service.create(ctx, { name })
}

describe("companies/service", () => {
  test("create validates, emits company.created and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const company = await expectAllowed(() => service.create(ctx, { name: "Acme" }))
      expect(company.name).toBe("Acme")
      events.expectEmitted("company.created", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "company",
        entityId: company.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "company",
        recordId: company.id,
      })
      expect(audits[0]?.after).toMatchObject({ name: "Acme" })
    } finally {
      events.release()
    }
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.create(ctx, { name: "  " })).rejects.toThrow()
  })

  test("get returns the company with addresses and children, list paginates", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const found = await expectAllowed(() => service.get(ctx, created.id))
    expect(found.company.id).toBe(created.id)
    expect(found.addresses).toEqual([])
    expect(found.children).toEqual([])
    const listed = await expectAllowed(() => service.list(ctx, { limit: 25 }))
    expect(listed.data).toHaveLength(1)
    expect(listed.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get includes child companies of a parent", async () => {
    const { ctx, service } = setup()
    const parent = await seed(service, ctx, "Parent Co")
    await service.create(ctx, { name: "Child Co", parentCompanyId: parent.id })
    const found = await expectAllowed(() => service.get(ctx, parent.id))
    expect(found.children).toHaveLength(1)
    expect(found.children[0]?.name).toBe("Child Co")
  })

  test("get throws NOT_FOUND for unknown ids", async () => {
    const { ctx, service } = setup()
    const err = await service.get(ctx, "missing").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe("NOT_FOUND")
  })

  test("update emits company.updated and audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const updated = await expectAllowed(() =>
        service.update(ctx, created.id, { industry: "Software" }),
      )
      expect(updated.industry).toBe("Software")
      const emitted = events.expectEmitted("company.updated", { entityId: created.id })
      expect(emitted.before).toMatchObject({ industry: null })
      expect(emitted.after).toMatchObject({ industry: "Software" })
      expect(audits.at(-1)).toMatchObject({ action: "update", recordId: created.id })
    } finally {
      events.release()
    }
  })

  test("softDelete emits company.deleted and hides the row; restore revives it", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      await expectAllowed(() => service.softDelete(ctx, created.id))
      events.expectEmitted("company.deleted", { entityId: created.id })
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
    let companyId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      companyId = (await seed(owner.service, owner.ctx)).id
    })

    test("viewer cannot create", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.create(ctx, { name: "Nope" }))
    })

    test("viewer cannot update", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.update(ctx, companyId, { industry: "X" }))
    })

    test("member cannot delete (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDelete(ctx, companyId))
    })

    test("viewer can still list and get (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectAllowed(() => service.list(ctx, {}))
      await expectAllowed(() => service.get(ctx, companyId))
    })
  })
})
