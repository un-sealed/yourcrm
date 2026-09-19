import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import {
  createCustomObjectsService,
  type CustomObjectDefinitionRecord,
  type CustomObjectFieldRecord,
  type CustomObjectRecordRow,
  type CustomObjectsService,
  type CustomObjectsStore,
} from "@yourcrm/crm/src/custom-objects"
import { createApiClient, createStore, makeBaseRecord, makeSession } from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes } from "./custom-objects"

type StoredObject = BaseRecord & { slug: string; name: string; pluralName: string }
type StoredField = BaseRecord & {
  objectType: string
  key: string
  label: string
  fieldType: string
  options: string[] | null
  defaultValue: unknown
  required: boolean
  displayOrder: number
}
type StoredRecord = BaseRecord & {
  objectId: string
  ownerId: string | null
  displayName: string
  fieldValues: Record<string, unknown>
}

function page<T>(rows: T[], limit: number | undefined, idOf: (row: T) => string) {
  const size = Math.min(Math.max(limit ?? 25, 1), 200)
  const data = rows.slice(0, size)
  const last = data[data.length - 1]
  return {
    data,
    pagination: { nextCursor: rows.length > size && last ? idOf(last) : null, limit: size },
  }
}

/** The real domain service over a hermetic in-memory store (no Postgres). */
function makeFakeService(): CustomObjectsService {
  const objects = createStore<StoredObject>()
  const fields = createStore<StoredField>()
  const records = createStore<StoredRecord>()

  const store: CustomObjectsStore = {
    listObjects: async (workspaceId, query) => {
      const rows = objects.list(workspaceId)
      const result = page(rows, query.limit, (row) => row.id)
      return {
        data: result.data as unknown as CustomObjectDefinitionRecord[],
        pagination: result.pagination,
      }
    },
    findObjectById: async (workspaceId, id) =>
      (objects.get(id, workspaceId) as unknown as CustomObjectDefinitionRecord | null) ?? null,
    findObjectBySlug: async (workspaceId, slug) =>
      (objects
        .list(workspaceId)
        .find((row) => row.slug === slug) as unknown as CustomObjectDefinitionRecord) ?? null,
    createObject: async (workspaceId, input, actorId) =>
      objects.insert({
        ...makeBaseRecord({ workspaceId }),
        slug: input.slug as string,
        name: input.name as string,
        pluralName: input.pluralName as string,
        ...(actorId === undefined ? {} : { createdBy: actorId }),
      }) as unknown as CustomObjectDefinitionRecord,
    updateObject: async (workspaceId, id, patch) =>
      (objects.update(
        id,
        workspaceId,
        patch as Partial<StoredObject>,
      ) as unknown as CustomObjectDefinitionRecord | null) ?? null,
    softDeleteObject: async (workspaceId, id) => {
      objects.remove(id, workspaceId)
    },
    restoreObject: async (workspaceId, id) => {
      objects.restore(id, workspaceId)
    },

    listFields: async (workspaceId, objectType) =>
      fields
        .list(workspaceId)
        .filter((row) => row.objectType === objectType)
        .sort((a, b) => a.displayOrder - b.displayOrder) as unknown as CustomObjectFieldRecord[],
    findFieldById: async (workspaceId, id) =>
      (fields.get(id, workspaceId) as unknown as CustomObjectFieldRecord | null) ?? null,
    createField: async (workspaceId, input) =>
      fields.insert({
        ...makeBaseRecord({ workspaceId }),
        objectType: input.objectType as string,
        key: input.key as string,
        label: input.label as string,
        fieldType: input.fieldType as string,
        options: (input.options as string[] | null) ?? null,
        defaultValue: input.defaultValue ?? null,
        required: (input.required as boolean | undefined) ?? false,
        displayOrder: (input.displayOrder as number | undefined) ?? 0,
      }) as unknown as CustomObjectFieldRecord,
    updateField: async (workspaceId, id, patch) =>
      (fields.update(
        id,
        workspaceId,
        patch as Partial<StoredField>,
      ) as unknown as CustomObjectFieldRecord | null) ?? null,
    softDeleteField: async (workspaceId, id) => {
      fields.remove(id, workspaceId)
    },

    listRecords: async (workspaceId, objectId, query) => {
      let rows = records.list(workspaceId).filter((row) => row.objectId === objectId)
      if (query.query) {
        const q = query.query.toLowerCase()
        rows = rows.filter((row) => row.displayName.toLowerCase().includes(q))
      }
      for (const [key, value] of Object.entries(query.match ?? {})) {
        rows = rows.filter((row) => row.fieldValues[key] === value)
      }
      const result = page(rows, query.limit, (row) => row.id)
      return {
        data: result.data as unknown as CustomObjectRecordRow[],
        pagination: result.pagination,
      }
    },
    findRecordById: async (workspaceId, objectId, id) => {
      const row = records.get(id, workspaceId)
      return row && row.objectId === objectId ? (row as unknown as CustomObjectRecordRow) : null
    },
    createRecord: async (workspaceId, input) =>
      records.insert({
        ...makeBaseRecord({ workspaceId }),
        objectId: input.objectId as string,
        ownerId: (input.ownerId as string | null) ?? null,
        displayName: input.displayName as string,
        fieldValues: (input.fieldValues as Record<string, unknown>) ?? {},
      }) as unknown as CustomObjectRecordRow,
    updateRecord: async (workspaceId, objectId, id, patch) => {
      const current = records.get(id, workspaceId)
      if (!current || current.objectId !== objectId) return null
      const row = records.update(id, workspaceId, patch as Partial<StoredRecord>)
      return (row as unknown as CustomObjectRecordRow | null) ?? null
    },
    softDeleteRecord: async (workspaceId, id) => {
      records.remove(id, workspaceId)
    },
    restoreRecord: async (workspaceId, id) => {
      records.restore(id, workspaceId)
    },
  }

  return createCustomObjectsService({ store, audit: async () => undefined })
}

/** Sessions ride a tiny test-only middleware (role-accurate, no database). */
function makeTestApp(session: { current: Session | null }, service: CustomObjectsService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/custom-objects", createRoutes({ service }))
  return app
}

const BASE = "/api/v1/custom-objects"

describe("api/custom-objects", () => {
  let session: { current: Session | null }
  let service: CustomObjectsService
  let api: ReturnType<typeof createApiClient>
  let workspaceId: string

  beforeEach(() => {
    const owner = makeSession({ role: "owner" })
    workspaceId = owner.workspaceId ?? owner.memberships[0]?.workspaceId ?? ""
    session = { current: owner }
    service = makeFakeService()
    api = createApiClient({ app: makeTestApp(session, service) })
  })

  async function seed() {
    await api.post(BASE, { slug: "deal-room", name: "Deal room" }, { expectedStatus: 201 })
    await api.post(
      `${BASE}/deal-room/fields`,
      { key: "title", label: "Title", fieldType: "text", required: true, displayOrder: 0 },
      { expectedStatus: 201 },
    )
    const res = await api.post(
      `${BASE}/deal-room/fields`,
      { key: "seats", label: "Seats", fieldType: "number", displayOrder: 1 },
      { expectedStatus: 201 },
    )
    return (res.expectSuccess().data as { id: string }).id
  }

  test("unauthenticated requests get UNAUTHORIZED", async () => {
    session.current = null
    const res = await api.get(BASE)
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope", async () => {
    await api.post(BASE, { slug: "deal-room", name: "Deal room" })
    const res = await api.get(BASE)
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("create rejects reserved and malformed slugs with VALIDATION_ERROR", async () => {
    const reserved = await api.post(BASE, { slug: "person", name: "Person" })
    expect(reserved.status).toBe(400)
    expect(reserved.expectError("VALIDATION_ERROR").error.message).toContain("reserved")
    const malformed = await api.post(BASE, { slug: "deal room", name: "Deal room" })
    expect(malformed.status).toBe(400)
    const traversal = await api.post(BASE, { slug: "../../secrets", name: "Escape" })
    expect(traversal.status).toBe(400)
  })

  test("duplicate slugs are a CONFLICT", async () => {
    await api.post(BASE, { slug: "deal-room", name: "Deal room" }, { expectedStatus: 201 })
    const again = await api.post(BASE, { slug: "deal-room", name: "Again" })
    expect(again.status).toBe(409)
    again.expectError("CONFLICT")
  })

  test("patching the slug is rejected; renaming is allowed", async () => {
    await api.post(BASE, { slug: "deal-room", name: "Deal room" })
    const bad = await api.patch(`${BASE}/deal-room`, { slug: "other" })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const ok = await api.patch(`${BASE}/deal-room`, { name: "Renamed" })
    expect(ok.status).toBe(200)
  })

  test("unknown slugs are NOT_FOUND", async () => {
    const res = await api.get(`${BASE}/no-such-object`)
    expect(res.status).toBe(404)
    res.expectError("NOT_FOUND")
  })

  test("get returns the definition with its fields", async () => {
    await seed()
    const res = await api.get(`${BASE}/deal-room`)
    expect(res.status).toBe(200)
    const data = res.expectSuccess().data as { slug: string; fields: { key: string }[] }
    expect(data.slug).toBe("deal-room")
    expect(data.fields.map((field) => field.key)).toEqual(["title", "seats"])
  })

  test("viewer definition changes are FORBIDDEN (admin-only per spec 33)", async () => {
    session.current = makeSession({ role: "member", workspaceId })
    const res = await api.post(BASE, { slug: "sneaky", name: "Sneaky" })
    expect(res.status).toBe(403)
    res.expectError("FORBIDDEN")
  })

  test("field creation rejects reserved keys and option-less selects", async () => {
    await seed()
    const reserved = await api.post(`${BASE}/deal-room/fields`, {
      key: "id",
      label: "Id",
      fieldType: "text",
    })
    expect(reserved.status).toBe(400)
    const noOptions = await api.post(`${BASE}/deal-room/fields`, {
      key: "stage",
      label: "Stage",
      fieldType: "select",
      options: [],
    })
    expect(noOptions.status).toBe(400)
    const unknownType = await api.post(`${BASE}/deal-room/fields`, {
      key: "price",
      label: "Price",
      fieldType: "currency",
    })
    expect(unknownType.status).toBe(400)
  })

  test("changing a field's type or key is a 400, not a silent no-op", async () => {
    const seatsId = await seed()
    const typeChange = await api.patch(`${BASE}/deal-room/fields/${seatsId}`, {
      fieldType: "text",
    })
    expect(typeChange.status).toBe(400)
    typeChange.expectError("VALIDATION_ERROR")
    const keyChange = await api.patch(`${BASE}/deal-room/fields/${seatsId}`, { key: "places" })
    expect(keyChange.status).toBe(400)
    const stillNumber = await api.get(`${BASE}/deal-room`)
    const fields = (
      stillNumber.expectSuccess().data as { fields: { key: string; fieldType: string }[] }
    ).fields
    expect(fields.find((field) => field.key === "seats")?.fieldType).toBe("number")
  })

  test("records are validated against the live definitions", async () => {
    await seed()
    const missingRequired = await api.post(`${BASE}/deal-room/records`, { values: {} })
    expect(missingRequired.status).toBe(400)
    missingRequired.expectError("VALIDATION_ERROR")

    const wrongType = await api.post(`${BASE}/deal-room/records`, {
      values: { title: "Acme", seats: "four" },
    })
    expect(wrongType.status).toBe(400)

    const unknownKey = await api.post(`${BASE}/deal-room/records`, {
      values: { title: "Acme", rogue: 1 },
    })
    expect(unknownKey.status).toBe(400)

    const created = await api.post(`${BASE}/deal-room/records`, {
      values: { title: "Acme", seats: 4 },
    })
    expect(created.status).toBe(201)
    const data = created.expectSuccess().data as {
      displayName: string
      fieldValues: Record<string, unknown>
    }
    expect(data.displayName).toBe("Acme")
    expect(data.fieldValues).toEqual({ title: "Acme", seats: 4 })
  })

  test("deleting a field preserves stored values through later writes", async () => {
    const seatsId = await seed()
    const created = await api.post(`${BASE}/deal-room/records`, {
      values: { title: "Acme", seats: 4 },
    })
    const recordId = (created.expectSuccess().data as { id: string }).id

    const removed = await api.delete(`${BASE}/deal-room/fields/${seatsId}`)
    expect(removed.status).toBe(200)

    const patched = await api.patch(`${BASE}/deal-room/records/${recordId}`, {
      values: { title: "Acme II" },
    })
    expect(patched.status).toBe(200)
    const after = patched.expectSuccess().data as { fieldValues: Record<string, unknown> }
    expect(after.fieldValues).toEqual({ title: "Acme II", seats: 4 })
  })

  test("records list filters by search and by an exact field value", async () => {
    await seed()
    await api.post(`${BASE}/deal-room/records`, { values: { title: "Acme", seats: 1 } })
    await api.post(`${BASE}/deal-room/records`, { values: { title: "Globex", seats: 2 } })
    const search = await api.get(`${BASE}/deal-room/records?query=glob`)
    expect(search.expectSuccess().data).toHaveLength(1)
    const unknownField = await api.get(`${BASE}/deal-room/records?field=nope&value=x`)
    expect(unknownField.status).toBe(400)
    unknownField.expectError("VALIDATION_ERROR")
  })

  test("record delete and restore round-trip", async () => {
    await seed()
    const created = await api.post(`${BASE}/deal-room/records`, { values: { title: "Acme" } })
    const id = (created.expectSuccess().data as { id: string }).id
    expect((await api.delete(`${BASE}/deal-room/records/${id}`)).status).toBe(200)
    expect((await api.get(`${BASE}/deal-room/records/${id}`)).status).toBe(404)
    expect((await api.post(`${BASE}/deal-room/records/${id}/restore`)).status).toBe(200)
    const back = await api.get(`${BASE}/deal-room/records/${id}`)
    expect(back.status).toBe(200)
    const data = back.expectSuccess().data as { fields: unknown[]; object: { slug: string } }
    expect(data.object.slug).toBe("deal-room")
    expect(data.fields).toHaveLength(2)
  })

  test("object delete and restore round-trip", async () => {
    await seed()
    const list = await api.get(BASE)
    const id = ((list.expectSuccess().data as { id: string }[])[0] ?? { id: "" }).id
    expect((await api.delete(`${BASE}/deal-room`)).status).toBe(200)
    expect((await api.get(`${BASE}/deal-room`)).status).toBe(404)
    expect((await api.post(`${BASE}/${id}/restore`)).status).toBe(200)
    expect((await api.get(`${BASE}/deal-room`)).status).toBe(200)
  })

  test("viewer record writes are FORBIDDEN but reads are allowed", async () => {
    await seed()
    session.current = makeSession({ role: "viewer", workspaceId })
    const read = await api.get(`${BASE}/deal-room/records`)
    expect(read.status).toBe(200)
    const write = await api.post(`${BASE}/deal-room/records`, { values: { title: "Nope" } })
    expect(write.status).toBe(403)
    write.expectError("FORBIDDEN")
  })
})
