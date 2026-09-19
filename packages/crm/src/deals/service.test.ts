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
import { createDealsService, type DealsService, type DealRecord } from "./index"
import type { DealAuditInput, DealListQuery } from "./types"

type StoredDeal = BaseRecord & {
  name: string
  amount: string | null
  currency: string
  pipelineId: string | null
  stageId: string | null
  stage: string
  probability: number | null
  expectedCloseDate: string | null
  personId: string | null
  companyId: string | null
  ownerId: string | null
  closeReason: string | null
  notes: string | null
}

function asRecord(row: StoredDeal): DealRecord {
  return row as unknown as DealRecord
}

/** Hermetic DealsStore port backed by the shared in-memory store. */
function makeStore() {
  const deals = createStore<StoredDeal>()
  return {
    deals,
    store: {
      list: async (workspaceId: string, query: DealListQuery) => {
        let rows = deals.list(workspaceId)
        if (query.stage) rows = rows.filter((r) => r.stage === query.stage)
        if (query.pipelineId) rows = rows.filter((r) => r.pipelineId === query.pipelineId)
        if (query.query) {
          const q = query.query.toLowerCase()
          rows = rows.filter((r) => r.name.toLowerCase().includes(q))
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
        const row = deals.get(id, workspaceId)
        return row ? asRecord(row) : null
      },
      create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
        const record: StoredDeal = {
          ...makeBaseRecord({ workspaceId }),
          name: input.name as string,
          amount: input.amount === undefined || input.amount === null ? null : String(input.amount),
          currency: (input.currency as string | null) ?? "USD",
          pipelineId: (input.pipelineId as string | null) ?? null,
          stageId: (input.stageId as string | null) ?? null,
          stage: (input.stage as string | null) ?? "qualification",
          probability: (input.probability as number | null) ?? null,
          expectedCloseDate: (input.expectedCloseDate as string | null) ?? null,
          personId: (input.personId as string | null) ?? null,
          companyId: (input.companyId as string | null) ?? null,
          ownerId: (input.ownerId as string | null) ?? null,
          closeReason: (input.closeReason as string | null) ?? null,
          notes: (input.notes as string | null) ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }
        return asRecord(deals.insert(record))
      },
      update: async (
        workspaceId: string,
        id: string,
        input: Record<string, unknown>,
        _actorId?: string,
      ) => {
        const row = deals.update(id, workspaceId, input as Partial<StoredDeal>)
        return row ? asRecord(row) : null
      },
      changeStage: async (
        workspaceId: string,
        id: string,
        input: Record<string, unknown>,
        _actorId?: string,
      ) => {
        const row = deals.update(id, workspaceId, {
          stage: input.stage,
          stageId: (input.stageId as string | null) ?? null,
        } as Partial<StoredDeal>)
        return row ? asRecord(row) : null
      },
      close: async (
        workspaceId: string,
        id: string,
        input: Record<string, unknown>,
        _actorId?: string,
      ) => {
        const row = deals.update(id, workspaceId, {
          stage: input.stage,
          closeReason: (input.closeReason as string | null) ?? null,
        } as Partial<StoredDeal>)
        return row ? asRecord(row) : null
      },
      softDelete: async (workspaceId: string, id: string) => {
        deals.remove(id, workspaceId)
      },
      restore: async (workspaceId: string, id: string) => {
        deals.restore(id, workspaceId)
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
  const audits: DealAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createDealsService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seed(service: DealsService, ctx: ServiceContext, name = "Acme renewal") {
  return service.create(ctx, { name, amount: 50000, currency: "USD", probability: 50 })
}

describe("deals/service", () => {
  test("create validates, emits deal.created and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const deal = await expectAllowed(() =>
        service.create(ctx, { name: "Acme renewal", amount: 50000, probability: 50 }),
      )
      expect(deal.name).toBe("Acme renewal")
      events.expectEmitted("deal.created", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "deal",
        entityId: deal.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "deal",
        recordId: deal.id,
      })
      expect(audits[0]?.after).toMatchObject({ name: "Acme renewal" })
    } finally {
      events.release()
    }
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.create(ctx, { name: "  " })).rejects.toThrow()
    await expect(service.create(ctx, { name: "Ok", probability: 101 })).rejects.toThrow()
    await expect(service.create(ctx, { name: "Ok", currency: "US" })).rejects.toThrow()
  })

  test("get returns the deal, list paginates and filters by stage", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const found = await expectAllowed(() => service.get(ctx, created.id))
    expect(found.id).toBe(created.id)
    const listed = await expectAllowed(() => service.list(ctx, { limit: 25 }))
    expect(listed.data).toHaveLength(1)
    expect(listed.pagination).toEqual({ nextCursor: null, limit: 25 })
    const filtered = await expectAllowed(() => service.list(ctx, { stage: "proposal" }))
    expect(filtered.data).toHaveLength(0)
  })

  test("get throws NOT_FOUND for unknown ids", async () => {
    const { ctx, service } = setup()
    const err = await service.get(ctx, "missing").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe("NOT_FOUND")
  })

  test("update emits deal.updated and audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const updated = await expectAllowed(() => service.update(ctx, created.id, { amount: 60000 }))
      expect(updated.amount).toBe(60000)
      const emitted = events.expectEmitted("deal.updated", { entityId: created.id })
      expect(emitted.before).toMatchObject({ amount: "50000" })
      expect(emitted.after).toMatchObject({ amount: 60000 })
      expect(audits.at(-1)).toMatchObject({ action: "update", recordId: created.id })
    } finally {
      events.release()
    }
  })

  test("changeStage emits deal.stage_changed (not deal.updated)", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const moved = await expectAllowed(() =>
        service.changeStage(ctx, created.id, { stage: "proposal" }),
      )
      expect(moved.stage).toBe("proposal")
      const emitted = events.expectEmitted("deal.stage_changed", { entityId: created.id })
      expect(emitted.before).toMatchObject({ stage: "qualification" })
      expect(emitted.after).toMatchObject({ stage: "proposal" })
      expect(events.count("deal.updated")).toBe(0)
      expect(audits.at(-1)).toMatchObject({ action: "stage_changed", recordId: created.id })
    } finally {
      events.release()
    }
  })

  test("markWon emits deal.won and markLost emits deal.lost", async () => {
    const { ctx, service } = setup()
    const won = await seed(service, ctx, "Win me")
    const lost = await seed(service, ctx, "Lose me")
    const events = captureEvents()
    try {
      const closedWon = await expectAllowed(() =>
        service.markWon(ctx, won.id, { closeReason: "Signed" }),
      )
      expect(closedWon.stage).toBe("won")
      events.expectEmitted("deal.won", { entityId: won.id })
      const closedLost = await expectAllowed(() =>
        service.markLost(ctx, lost.id, { closeReason: "Budget" }),
      )
      expect(closedLost.stage).toBe("lost")
      events.expectEmitted("deal.lost", { entityId: lost.id })
    } finally {
      events.release()
    }
  })

  test("softDelete emits deal.deleted and hides the row; restore revives it", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      await expectAllowed(() => service.softDelete(ctx, created.id))
      events.expectEmitted("deal.deleted", { entityId: created.id })
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
    let dealId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      dealId = (await seed(owner.service, owner.ctx)).id
    })

    test("viewer cannot create", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.create(ctx, { name: "Nope" }))
    })

    test("viewer cannot update", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.update(ctx, dealId, { notes: "X" }))
    })

    test("viewer cannot change stage", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.changeStage(ctx, dealId, { stage: "proposal" }))
    })

    test("viewer cannot close as won", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.markWon(ctx, dealId, {}))
    })

    test("member cannot delete (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDelete(ctx, dealId))
    })

    test("viewer can still list and get (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectAllowed(() => service.list(ctx, {}))
      await expectAllowed(() => service.get(ctx, dealId))
    })
  })
})
