import { beforeEach, describe, expect, test } from "bun:test"
import { expectDenied, makeServiceContext } from "@yourcrm/testing"
import { createComplianceService } from "./compliance-service"
import type {
  ComplianceServiceDeps,
  DataRequestRecord,
  SettingsAuditInput,
  WorkspaceAuditRecord,
} from "./types"

const WS = "11111111-1111-4111-8111-111111111111"
const ADMIN_USER = "33333333-3333-4333-8333-333333333333"
const MEMBER_USER = "44444444-4444-4444-8444-444444444444"
const SUBJECT = "77777777-7777-4777-8777-777777777777"
const NOW = "2026-03-01T12:00:00.000Z"

type Fake = {
  deps: ComplianceServiceDeps
  audits: SettingsAuditInput[]
  requests: Map<string, DataRequestRecord>
  deleted: string[]
}

function makeFake(): Fake {
  const audits: SettingsAuditInput[] = []
  const requests = new Map<string, DataRequestRecord>()
  const deleted: string[] = []
  let seq = 0
  const auditRows: WorkspaceAuditRecord[] = [
    {
      id: "audit-1",
      workspaceId: WS,
      actorId: ADMIN_USER,
      action: "settings.update",
      object: "workspace_settings",
      recordId: WS,
      before: { name: "Acme" },
      after: { name: "Acme Inc" },
      correlationId: "req-1",
      source: "user",
      createdAt: NOW,
    },
    {
      id: "audit-2",
      workspaceId: WS,
      actorId: ADMIN_USER,
      action: "membership.role_changed",
      object: "membership",
      recordId: "mem-1",
      before: { role: "member" },
      after: { role: "admin" },
      correlationId: "req-2",
      source: "user",
      createdAt: NOW,
    },
  ]
  const person: Record<string, unknown> = { id: SUBJECT, firstName: "Ada", deletedAt: null }

  const deps: ComplianceServiceDeps = {
    audit: async (input) => {
      audits.push(input)
    },
    auditLog: {
      list: async (_workspaceId, query) => ({
        data: auditRows.filter((row) =>
          query.object === undefined ? true : row.object === query.object,
        ),
        pagination: { nextCursor: null, limit: query.limit ?? 25 },
      }),
      findById: async (_workspaceId, id) => auditRows.find((row) => row.id === id) ?? null,
    },
    requests: {
      list: async (_workspaceId, query) => ({
        data: [...requests.values()].filter((row) =>
          query.kind === undefined ? true : row.kind === query.kind,
        ),
        pagination: { nextCursor: null, limit: query.limit ?? 25 },
      }),
      findById: async (_workspaceId, id) => requests.get(id) ?? null,
      create: async (workspaceId, input, actorId) => {
        seq += 1
        const row: DataRequestRecord = {
          id: `req-${seq}`,
          workspaceId,
          kind: input.kind,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          status: input.status ?? "pending",
          reason: input.reason ?? null,
          requestedBy: actorId ?? null,
          completedAt: null,
          completedBy: null,
          createdAt: NOW,
        }
        requests.set(row.id, row)
        return row
      },
      markStatus: async (_workspaceId, id, status, actorId) => {
        const current = requests.get(id)
        if (!current) return null
        const next = { ...current, status, completedAt: NOW, completedBy: actorId ?? null }
        requests.set(id, next)
        return next
      },
    },
    subjects: {
      load: async (_workspaceId, subjectId) =>
        subjectId === SUBJECT && person.deletedAt === null ? { ...person } : null,
      softDelete: async (_workspaceId, subjectId) => {
        if (subjectId !== SUBJECT) return false
        person.deletedAt = NOW
        deleted.push(subjectId)
        return true
      },
    },
  }
  return { deps, audits, requests, deleted }
}

function ctxFor(role: string, actorId = ADMIN_USER) {
  return makeServiceContext({ workspaceId: WS, actorId, role })
}

describe("settings/audit-log", () => {
  let fake: Fake

  beforeEach(() => {
    fake = makeFake()
  })

  test("an admin reads and filters the audit log", async () => {
    const service = createComplianceService(fake.deps)
    const ctx = ctxFor("admin")
    const all = await service.listAuditEvents(ctx, {})
    expect(all.data).toHaveLength(2)
    expect(all.pagination).toEqual({ nextCursor: null, limit: 25 })
    const filtered = await service.listAuditEvents(ctx, { object: "membership" })
    expect(filtered.data.map((row) => row.id)).toEqual(["audit-2"])
    expect((await service.getAuditEvent(ctx, "audit-1"))?.action).toBe("settings.update")
  })

  test("members cannot read the audit log (it describes records they cannot see)", async () => {
    const service = createComplianceService(fake.deps)
    await expectDenied(() => service.listAuditEvents(ctxFor("member", MEMBER_USER), {}))
    await expectDenied(() => service.getAuditEvent(ctxFor("viewer", MEMBER_USER), "audit-1"))
  })

  test("APPEND-ONLY: the service exposes no way to modify an audit row", () => {
    const service = createComplianceService(fake.deps)
    const surface = Object.keys(service)
    for (const forbidden of [
      "updateAuditEvent",
      "deleteAuditEvent",
      "removeAuditEvent",
      "purgeAuditEvents",
      "editAuditEvent",
      "restoreAuditEvent",
    ]) {
      expect(surface).not.toContain(forbidden)
    }
    // ...and nothing that merely *looks* like a mutation of one, either.
    const auditMutators = surface.filter(
      (name) =>
        /audit/i.test(name) && /update|delete|remove|purge|edit|write|insert|restore/i.test(name),
    )
    expect(auditMutators).toEqual([])
  })

  test("APPEND-ONLY: the injected audit port itself has only reads", () => {
    const port = fake.deps.auditLog as unknown as Record<string, unknown>
    expect(Object.keys(port).sort()).toEqual(["findById", "list"])
  })

  test("reading the audit log writes no audit row (no feedback loop)", async () => {
    const service = createComplianceService(fake.deps)
    await service.listAuditEvents(ctxFor("owner"), {})
    expect(fake.audits).toHaveLength(0)
  })
})

describe("settings/data-requests", () => {
  let fake: Fake

  beforeEach(() => {
    fake = makeFake()
  })

  test("an export request is recorded and fulfilled from live data", async () => {
    const service = createComplianceService(fake.deps)
    const ctx = ctxFor("admin")
    const request = await service.createDataRequest(ctx, {
      kind: "export",
      subjectId: SUBJECT,
      reason: "subject access request",
    })
    expect(request.status).toBe("pending")
    expect(fake.deleted).toHaveLength(0)

    const exported = await service.fulfilExportRequest(ctx, request.id)
    expect(exported.subjectId).toBe(SUBJECT)
    expect(exported.record.firstName).toBe("Ada")
    expect(fake.requests.get(request.id)?.status).toBe("fulfilled")
    expect(fake.audits.map((a) => a.action)).toEqual([
      "data_request.export",
      "data_request.fulfilled",
    ])
  })

  test("the stored request holds no subject data — only ids", async () => {
    const service = createComplianceService(fake.deps)
    const request = await service.createDataRequest(ctxFor("admin"), {
      kind: "export",
      subjectId: SUBJECT,
    })
    expect(JSON.stringify(fake.requests.get(request.id))).not.toContain("Ada")
    expect(JSON.stringify(fake.audits)).not.toContain("Ada")
  })

  test("a deletion request soft-deletes the subject and records the request", async () => {
    const service = createComplianceService(fake.deps)
    const ctx = ctxFor("owner")
    const request = await service.createDataRequest(ctx, {
      kind: "deletion",
      subjectId: SUBJECT,
      reason: "erasure request",
    })
    expect(request.status).toBe("soft_deleted")
    expect(fake.deleted).toEqual([SUBJECT])
    expect(fake.audits.map((a) => a.action)).toEqual([
      "data_request.deletion",
      "data_request.soft_deleted",
    ])
    // P0 never hard-deletes: the request row survives to prove what happened.
    expect(fake.requests.get(request.id)).toBeDefined()
  })

  test("fulfilling a deletion request as an export is refused", async () => {
    const service = createComplianceService(fake.deps)
    const ctx = ctxFor("owner")
    const request = await service.createDataRequest(ctx, { kind: "deletion", subjectId: SUBJECT })
    await expect(service.fulfilExportRequest(ctx, request.id)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    })
  })

  test("an unknown subject or request is a 404", async () => {
    const service = createComplianceService(fake.deps)
    const ctx = ctxFor("owner")
    await expect(
      service.createDataRequest(ctx, {
        kind: "export",
        subjectId: "88888888-8888-4888-8888-888888888888",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(service.fulfilExportRequest(ctx, "req-nope")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  test("members cannot request exports or deletions", async () => {
    const service = createComplianceService(fake.deps)
    const ctx = ctxFor("member", MEMBER_USER)
    await expectDenied(() => service.listDataRequests(ctx, {}))
    await expectDenied(() => service.createDataRequest(ctx, { kind: "export", subjectId: SUBJECT }))
    await expectDenied(() =>
      service.createDataRequest(ctx, { kind: "deletion", subjectId: SUBJECT }),
    )
    expect(fake.deleted).toHaveLength(0)
    expect(fake.audits).toHaveLength(0)
  })
})
