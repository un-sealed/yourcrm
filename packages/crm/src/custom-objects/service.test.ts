import { beforeEach, describe, expect, test } from "bun:test"
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
import { createCustomObjectsService, type CustomObjectsService } from "./index"
import { CustomObjectValidationError } from "./errors"
import type {
  CustomObjectAuditInput,
  CustomObjectDefinitionRecord,
  CustomObjectFieldRecord,
  CustomObjectListQuery,
  CustomObjectRecordListQuery,
  CustomObjectRecordRow,
  CustomObjectsStore,
} from "./types"

type StoredObject = BaseRecord & {
  slug: string
  name: string
  pluralName: string
  icon: string | null
  description: string | null
}

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

function asObject(row: StoredObject): CustomObjectDefinitionRecord {
  return row as unknown as CustomObjectDefinitionRecord
}

function asField(row: StoredField): CustomObjectFieldRecord {
  return row as unknown as CustomObjectFieldRecord
}

function asRecord(row: StoredRecord): CustomObjectRecordRow {
  return row as unknown as CustomObjectRecordRow
}

function paginate<T>(rows: T[], limit: number | undefined, idOf: (row: T) => string) {
  const size = Math.min(Math.max(limit ?? 25, 1), 200)
  const data = rows.slice(0, size)
  const last = data[data.length - 1]
  return {
    data,
    pagination: {
      nextCursor: rows.length > size && last ? idOf(last) : null,
      limit: size,
    },
  }
}

/**
 * Hermetic CustomObjectsStore over the shared in-memory store. It mirrors
 * the real persistence semantics the engine depends on: soft delete hides a
 * field definition without touching stored record payloads, and a record
 * write replaces the whole `fieldValues` object the service hands it.
 */
function makeBackingStore() {
  const objects = createStore<StoredObject>()
  const fields = createStore<StoredField>()
  const records = createStore<StoredRecord>()

  const store: CustomObjectsStore = {
    listObjects: async (workspaceId: string, query: CustomObjectListQuery) => {
      let rows = objects.list(workspaceId)
      if (query.query) {
        const q = query.query.toLowerCase()
        rows = rows.filter((row) => `${row.name} ${row.slug}`.toLowerCase().includes(q))
      }
      const page = paginate(rows, query.limit, (row) => row.id)
      return { data: page.data.map(asObject), pagination: page.pagination }
    },
    findObjectById: async (workspaceId, id) => {
      const row = objects.get(id, workspaceId)
      return row ? asObject(row) : null
    },
    findObjectBySlug: async (workspaceId, slug) => {
      const row = objects.list(workspaceId).find((candidate) => candidate.slug === slug)
      return row ? asObject(row) : null
    },
    createObject: async (workspaceId, input, actorId) =>
      asObject(
        objects.insert({
          ...makeBaseRecord({ workspaceId }),
          slug: input.slug as string,
          name: input.name as string,
          pluralName: input.pluralName as string,
          icon: (input.icon as string | null) ?? null,
          description: (input.description as string | null) ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      ),
    updateObject: async (workspaceId, id, patch) => {
      const row = objects.update(id, workspaceId, patch as Partial<StoredObject>)
      return row ? asObject(row) : null
    },
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
        .sort((a, b) => a.displayOrder - b.displayOrder || a.key.localeCompare(b.key))
        .map(asField),
    findFieldById: async (workspaceId, id) => {
      const row = fields.get(id, workspaceId)
      return row ? asField(row) : null
    },
    createField: async (workspaceId, input, actorId) =>
      asField(
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
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      ),
    updateField: async (workspaceId, id, patch) => {
      const row = fields.update(id, workspaceId, patch as Partial<StoredField>)
      return row ? asField(row) : null
    },
    softDeleteField: async (workspaceId, id) => {
      fields.remove(id, workspaceId)
    },

    listRecords: async (workspaceId, objectId, query: CustomObjectRecordListQuery) => {
      let rows = records.list(workspaceId).filter((row) => row.objectId === objectId)
      if (query.query) {
        const q = query.query.toLowerCase()
        rows = rows.filter((row) => row.displayName.toLowerCase().includes(q))
      }
      for (const [key, value] of Object.entries(query.match ?? {})) {
        rows = rows.filter((row) => row.fieldValues[key] === value)
      }
      const page = paginate(rows, query.limit, (row) => row.id)
      return { data: page.data.map(asRecord), pagination: page.pagination }
    },
    findRecordById: async (workspaceId, objectId, id) => {
      const row = records.get(id, workspaceId)
      return row && row.objectId === objectId ? asRecord(row) : null
    },
    createRecord: async (workspaceId, input, actorId) =>
      asRecord(
        records.insert({
          ...makeBaseRecord({ workspaceId }),
          objectId: input.objectId as string,
          ownerId: (input.ownerId as string | null) ?? null,
          displayName: input.displayName as string,
          fieldValues: (input.fieldValues as Record<string, unknown>) ?? {},
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      ),
    updateRecord: async (workspaceId, objectId, id, patch) => {
      const current = records.get(id, workspaceId)
      if (!current || current.objectId !== objectId) return null
      const row = records.update(id, workspaceId, patch as Partial<StoredRecord>)
      return row ? asRecord(row) : null
    },
    softDeleteRecord: async (workspaceId, id) => {
      records.remove(id, workspaceId)
    },
    restoreRecord: async (workspaceId, id) => {
      records.restore(id, workspaceId)
    },
  }

  return { objects, fields, records, store }
}

type Harness = {
  service: CustomObjectsService
  ctx: ReturnType<typeof makeServiceContext>
  audits: CustomObjectAuditInput[]
  backing: ReturnType<typeof makeBackingStore>
}

function setup(
  role: "owner" | "admin" | "member" | "viewer" = "owner",
  shared?: ReturnType<typeof makeBackingStore>,
  workspaceId?: string,
): Harness {
  const session = makeSession({ role, ...(workspaceId === undefined ? {} : { workspaceId }) })
  const ctx = makeServiceContext({ session })
  const audits: CustomObjectAuditInput[] = []
  const backing = shared ?? makeBackingStore()
  const service = createCustomObjectsService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { service, ctx, audits, backing }
}

/** An object with a required text field, an optional number and a select. */
async function seedObject(harness: Harness, slug = "deal-room") {
  const object = await harness.service.createObject(harness.ctx, {
    slug,
    name: "Deal room",
    pluralName: "Deal rooms",
  })
  await harness.service.createField(harness.ctx, slug, {
    key: "title",
    label: "Title",
    fieldType: "text",
    required: true,
    displayOrder: 0,
  })
  await harness.service.createField(harness.ctx, slug, {
    key: "seats",
    label: "Seats",
    fieldType: "number",
    displayOrder: 1,
  })
  await harness.service.createField(harness.ctx, slug, {
    key: "tier",
    label: "Tier",
    fieldType: "select",
    options: ["gold", "silver"],
    displayOrder: 2,
  })
  return object
}

describe("custom-objects/object definitions", () => {
  test("create stores a normalized slug, derived plural and an audit row", async () => {
    const h = setup()
    const object = await h.service.createObject(h.ctx, { slug: " Deal-Room ", name: "Deal room" })
    expect(object.slug).toBe("deal-room")
    expect(object.pluralName).toBe("Deal rooms")
    expect(h.audits.at(-1)).toMatchObject({
      action: "create",
      object: "custom_object",
      recordId: object.id,
      correlationId: h.ctx.correlationId,
    })
  })

  test("reserved and malformed slugs never reach the store", async () => {
    const h = setup()
    await expect(h.service.createObject(h.ctx, { slug: "person", name: "Person" })).rejects.toThrow(
      CustomObjectValidationError,
    )
    await expect(
      h.service.createObject(h.ctx, { slug: "deal room", name: "Deal room" }),
    ).rejects.toThrow()
    await expect(
      h.service.createObject(h.ctx, { slug: "../../etc", name: "Escape" }),
    ).rejects.toThrow()
    expect(h.backing.objects.list(h.ctx.workspaceId)).toHaveLength(0)
  })

  test("slugs are unique per workspace but free in another one", async () => {
    const h = setup()
    await h.service.createObject(h.ctx, { slug: "deal-room", name: "Deal room" })
    await expect(
      h.service.createObject(h.ctx, { slug: "deal-room", name: "Again" }),
    ).rejects.toThrow(/already exists/)
    const other = setup("owner", h.backing, "ws_other")
    await expectAllowed(() =>
      other.service.createObject(other.ctx, { slug: "deal-room", name: "Deal room" }),
    )
  })

  test("the slug is immutable: patching it is a validation error", async () => {
    const h = setup()
    await h.service.createObject(h.ctx, { slug: "deal-room", name: "Deal room" })
    await expect(
      h.service.updateObject(h.ctx, "deal-room", { slug: "other-room" }),
    ).rejects.toThrow()
    await expectAllowed(() => h.service.updateObject(h.ctx, "deal-room", { name: "Renamed" }))
    const found = await h.service.getObject(h.ctx, "deal-room")
    expect(found.object.name).toBe("Renamed")
  })

  test("delete is soft and restore brings the object and its fields back", async () => {
    const h = setup()
    const object = await seedObject(h)
    await h.service.createRecord(h.ctx, "deal-room", { values: { title: "Acme" } })
    await h.service.deleteObject(h.ctx, "deal-room")
    await expect(h.service.getObject(h.ctx, "deal-room")).rejects.toThrow(/not found/)
    await h.service.restoreObject(h.ctx, object.id)
    const back = await h.service.getObject(h.ctx, "deal-room")
    expect(back.fields).toHaveLength(3)
    const list = await h.service.listRecords(h.ctx, "deal-room", {})
    expect(list.data).toHaveLength(1)
  })

  test("list returns the shared pagination envelope", async () => {
    const h = setup()
    await seedObject(h)
    const result = await h.service.listObjects(h.ctx, {})
    expect(result.data).toHaveLength(1)
    expect(result.pagination).toEqual({ nextCursor: null, limit: 25 })
  })
})

describe("custom-objects/field definitions", () => {
  test("field keys are normalized, unique per object and never reserved", async () => {
    const h = setup()
    await seedObject(h)
    const created = await h.service.createField(h.ctx, "deal-room", {
      key: " Renewal Date ",
      label: "Renewal date",
      fieldType: "date",
    })
    expect(created.key).toBe("renewal_date")
    await expect(
      h.service.createField(h.ctx, "deal-room", {
        key: "renewal_date",
        label: "Dup",
        fieldType: "date",
      }),
    ).rejects.toThrow(/already exists/)
    await expect(
      h.service.createField(h.ctx, "deal-room", { key: "id", label: "Id", fieldType: "text" }),
    ).rejects.toThrow(/reserved/)
  })

  test("a select field without options is refused at definition time", async () => {
    const h = setup()
    await seedObject(h)
    await expect(
      h.service.createField(h.ctx, "deal-room", {
        key: "stage",
        label: "Stage",
        fieldType: "select",
        options: [],
      }),
    ).rejects.toThrow(/no options/)
  })

  test("a default that does not fit its own field is refused", async () => {
    const h = setup()
    await seedObject(h)
    await expect(
      h.service.createField(h.ctx, "deal-room", {
        key: "budget",
        label: "Budget",
        fieldType: "number",
        defaultValue: "lots",
      }),
    ).rejects.toThrow()
  })

  test("CHANGING A FIELD TYPE IS REJECTED and leaves stored values intact", async () => {
    const h = setup()
    await seedObject(h)
    const record = await h.service.createRecord(h.ctx, "deal-room", {
      values: { title: "Acme" },
    })
    const fields = await h.service.listFields(h.ctx, "deal-room")
    const title = fields.find((field) => field.key === "title")
    expect(title).toBeDefined()
    if (!title) throw new Error("fixture missing the title field")

    await expect(
      h.service.updateField(h.ctx, "deal-room", title.id, { fieldType: "number" }),
    ).rejects.toThrow()
    await expect(
      h.service.updateField(h.ctx, "deal-room", title.id, { key: "headline" }),
    ).rejects.toThrow()

    // Nothing moved: same type, same key, same stored value.
    const after = await h.service.listFields(h.ctx, "deal-room")
    const stillTitle = after.find((field) => field.id === title.id)
    expect(stillTitle?.fieldType).toBe("text")
    expect(stillTitle?.key).toBe("title")
    const reread = await h.service.getRecord(h.ctx, "deal-room", record.id)
    expect(reread.record.fieldValues).toEqual({ title: "Acme" })
  })

  test("label, options, order and default can be amended", async () => {
    const h = setup()
    await seedObject(h)
    const fields = await h.service.listFields(h.ctx, "deal-room")
    const tier = fields.find((field) => field.key === "tier")
    if (!tier) throw new Error("fixture missing the tier field")
    const updated = await h.service.updateField(h.ctx, "deal-room", tier.id, {
      label: "Service tier",
      options: ["gold", "silver", "bronze"],
      defaultValue: "bronze",
    })
    expect(updated.label).toBe("Service tier")
    const record = await h.service.createRecord(h.ctx, "deal-room", { values: { title: "A" } })
    expect(record.fieldValues.tier).toBe("bronze")
  })

  test("a field belonging to another object is not addressable", async () => {
    const h = setup()
    await seedObject(h)
    await seedObject(h, "site-visit")
    const fields = await h.service.listFields(h.ctx, "site-visit")
    const foreign = fields[0]
    if (!foreign) throw new Error("fixture missing fields")
    await expect(
      h.service.updateField(h.ctx, "deal-room", foreign.id, { label: "Hijack" }),
    ).rejects.toThrow(/not found/)
  })

  test("DELETING A FIELD IS SOFT: stored values survive and come back", async () => {
    const h = setup()
    await seedObject(h)
    const record = await h.service.createRecord(h.ctx, "deal-room", {
      values: { title: "Acme", seats: 12, tier: "gold" },
    })
    const fields = await h.service.listFields(h.ctx, "deal-room")
    const seats = fields.find((field) => field.key === "seats")
    if (!seats) throw new Error("fixture missing the seats field")

    await h.service.deleteField(h.ctx, "deal-room", seats.id)
    const afterDelete = await h.service.listFields(h.ctx, "deal-room")
    expect(afterDelete.map((field) => field.key)).toEqual(["title", "tier"])

    // The value is still on disk, just no longer described by a definition.
    const stored = h.backing.records.get(record.id, h.ctx.workspaceId)
    expect(stored?.fieldValues.seats).toBe(12)

    // Writing the record again must not wipe the orphaned value.
    await h.service.updateRecord(h.ctx, "deal-room", record.id, {
      values: { title: "Acme II" },
    })
    const afterWrite = h.backing.records.get(record.id, h.ctx.workspaceId)
    expect(afterWrite?.fieldValues).toEqual({ title: "Acme II", seats: 12, tier: "gold" })

    // ...and it is readable again the moment the definition is restored.
    h.backing.fields.restore(seats.id, h.ctx.workspaceId)
    const restored = await h.service.getRecord(h.ctx, "deal-room", record.id)
    expect(restored.fields.map((field) => field.key)).toContain("seats")
    expect(restored.record.fieldValues.seats).toBe(12)
  })

  test("a soft-deleted field's key can no longer be written to", async () => {
    const h = setup()
    await seedObject(h)
    const fields = await h.service.listFields(h.ctx, "deal-room")
    const seats = fields.find((field) => field.key === "seats")
    if (!seats) throw new Error("fixture missing the seats field")
    await h.service.deleteField(h.ctx, "deal-room", seats.id)
    const record = await h.service.createRecord(h.ctx, "deal-room", { values: { title: "A" } })
    await expect(
      h.service.updateRecord(h.ctx, "deal-room", record.id, { values: { seats: 4 } }),
    ).rejects.toThrow(CustomObjectValidationError)
  })
})

describe("custom-objects/records", () => {
  test("a record is validated against the live definitions", async () => {
    const h = setup()
    await seedObject(h)
    const record = await h.service.createRecord(h.ctx, "deal-room", {
      values: { title: "Acme", seats: 4, tier: "gold" },
    })
    expect(record.fieldValues).toEqual({ title: "Acme", seats: 4, tier: "gold" })
    // Display name is derived from the first text field, so generic pages
    // never have to show an internal id.
    expect(record.displayName).toBe("Acme")
  })

  test("invalid, missing-required and unknown-key payloads are all refused", async () => {
    const h = setup()
    await seedObject(h)
    await expect(h.service.createRecord(h.ctx, "deal-room", { values: {} })).rejects.toThrow(
      CustomObjectValidationError,
    )
    await expect(
      h.service.createRecord(h.ctx, "deal-room", { values: { title: "A", seats: "four" } }),
    ).rejects.toThrow()
    await expect(
      h.service.createRecord(h.ctx, "deal-room", { values: { title: "A", tier: "bronze" } }),
    ).rejects.toThrow()
    await expect(
      h.service.createRecord(h.ctx, "deal-room", { values: { title: "A", rogue: 1 } }),
    ).rejects.toThrow()
    expect(h.backing.records.list(h.ctx.workspaceId)).toHaveLength(0)
  })

  test("a hostile __proto__ key cannot be stored", async () => {
    const h = setup()
    await seedObject(h)
    const hostile: unknown = JSON.parse('{"title": "A", "__proto__": {"polluted": true}}')
    await expect(h.service.createRecord(h.ctx, "deal-room", { values: hostile })).rejects.toThrow()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test("patching validates only the keys sent and refreshes the display name", async () => {
    const h = setup()
    await seedObject(h)
    const record = await h.service.createRecord(h.ctx, "deal-room", {
      values: { title: "Acme", seats: 4 },
    })
    const updated = await h.service.updateRecord(h.ctx, "deal-room", record.id, {
      values: { title: "Acme II" },
    })
    expect(updated.fieldValues).toEqual({ title: "Acme II", seats: 4 })
    expect(updated.displayName).toBe("Acme II")
  })

  test("an explicit null clears an optional field but never a required one", async () => {
    const h = setup()
    await seedObject(h)
    const record = await h.service.createRecord(h.ctx, "deal-room", {
      values: { title: "Acme", seats: 4 },
    })
    const cleared = await h.service.updateRecord(h.ctx, "deal-room", record.id, {
      values: { seats: null },
    })
    expect(cleared.fieldValues).toEqual({ title: "Acme" })
    await expect(
      h.service.updateRecord(h.ctx, "deal-room", record.id, { values: { title: null } }),
    ).rejects.toThrow()
  })

  test("list filters by display name and by an exact field value", async () => {
    const h = setup()
    await seedObject(h)
    await h.service.createRecord(h.ctx, "deal-room", { values: { title: "Acme", tier: "gold" } })
    await h.service.createRecord(h.ctx, "deal-room", {
      values: { title: "Globex", tier: "silver" },
    })
    const byName = await h.service.listRecords(h.ctx, "deal-room", { query: "glob" })
    expect(byName.data).toHaveLength(1)
    const byField = await h.service.listRecords(h.ctx, "deal-room", {
      field: "tier",
      value: "gold",
    })
    expect(byField.data).toHaveLength(1)
    expect(byField.data[0]?.displayName).toBe("Acme")
  })

  test("filtering by a field that does not exist is a validation error, not SQL", async () => {
    const h = setup()
    await seedObject(h)
    await expect(
      h.service.listRecords(h.ctx, "deal-room", { field: "tier'; DROP TABLE x--", value: "g" }),
    ).rejects.toThrow()
    await expect(
      h.service.listRecords(h.ctx, "deal-room", { field: "nope", value: "g" }),
    ).rejects.toThrow(/unknown field/)
  })

  test("records are workspace-scoped and unknown ids are NOT_FOUND", async () => {
    const h = setup()
    await seedObject(h)
    const record = await h.service.createRecord(h.ctx, "deal-room", { values: { title: "Acme" } })
    await expect(h.service.getRecord(h.ctx, "deal-room", "missing")).rejects.toThrow(/not found/)
    const other = setup("owner", h.backing, "ws_other")
    await other.service.createObject(other.ctx, { slug: "deal-room", name: "Deal room" })
    await expect(other.service.getRecord(other.ctx, "deal-room", record.id)).rejects.toThrow(
      /not found/,
    )
  })

  test("delete is soft and restore returns the record with its values", async () => {
    const h = setup()
    await seedObject(h)
    const record = await h.service.createRecord(h.ctx, "deal-room", {
      values: { title: "Acme", seats: 2 },
    })
    await h.service.deleteRecord(h.ctx, "deal-room", record.id)
    await expect(h.service.getRecord(h.ctx, "deal-room", record.id)).rejects.toThrow(/not found/)
    const restored = await h.service.restoreRecord(h.ctx, "deal-room", record.id)
    expect(restored.fieldValues).toEqual({ title: "Acme", seats: 2 })
  })

  test("every mutation writes an audit row with before/after", async () => {
    const h = setup()
    await seedObject(h)
    const record = await h.service.createRecord(h.ctx, "deal-room", { values: { title: "Acme" } })
    await h.service.updateRecord(h.ctx, "deal-room", record.id, { values: { title: "Acme II" } })
    await h.service.deleteRecord(h.ctx, "deal-room", record.id)
    const forRecord = h.audits.filter((entry) => entry.recordId === record.id)
    expect(forRecord.map((entry) => entry.action)).toEqual(["create", "update", "delete"])
    expect(forRecord[1]?.before).toBeDefined()
    expect(forRecord[1]?.after).toBeDefined()
  })
})

describe("custom-objects/permissions", () => {
  test("defining objects and fields is admin-only", async () => {
    const shared = makeBackingStore()
    const owner = setup("owner", shared)
    await seedObject(owner)
    const member = setup("member", shared, owner.ctx.workspaceId)
    await expectDenied(() =>
      member.service.createObject(member.ctx, { slug: "side-deal", name: "Side deal" }),
    )
    await expectDenied(() => member.service.updateObject(member.ctx, "deal-room", { name: "X" }))
    await expectDenied(() => member.service.deleteObject(member.ctx, "deal-room"))
    await expectDenied(() =>
      member.service.createField(member.ctx, "deal-room", {
        key: "sneak",
        label: "Sneak",
        fieldType: "text",
      }),
    )
    expect(shared.objects.list(owner.ctx.workspaceId)).toHaveLength(1)
  })

  test("members may use records, viewers may only read them", async () => {
    const shared = makeBackingStore()
    const owner = setup("owner", shared)
    await seedObject(owner)
    const member = setup("member", shared, owner.ctx.workspaceId)
    const record = await expectAllowed(() =>
      member.service.createRecord(member.ctx, "deal-room", { values: { title: "Acme" } }),
    )
    const viewer = setup("viewer", shared, owner.ctx.workspaceId)
    await expectAllowed(() => viewer.service.listRecords(viewer.ctx, "deal-room", {}))
    await expectDenied(() =>
      viewer.service.createRecord(viewer.ctx, "deal-room", { values: { title: "Nope" } }),
    )
    await expectDenied(() =>
      viewer.service.updateRecord(viewer.ctx, "deal-room", record.id, {
        values: { title: "Nope" },
      }),
    )
    await expectDenied(() => viewer.service.deleteRecord(viewer.ctx, "deal-room", record.id))
    // Deleting records needs the delete rank, which members do not have.
    await expectDenied(() => member.service.deleteRecord(member.ctx, "deal-room", record.id))
  })

  test("permission is checked before any store access", async () => {
    const shared = makeBackingStore()
    const owner = setup("owner", shared)
    await seedObject(owner)
    const viewer = setup("viewer", shared, owner.ctx.workspaceId)
    // A denied call on an object that does not exist must still be a denial,
    // proving requirePermission ran before the lookup.
    const denied = await expectDenied(() =>
      viewer.service.createRecord(viewer.ctx, "no-such-object", { values: {} }),
    )
    expect(denied.ctx.action).toBe("create")
  })
})

describe("custom-objects/events", () => {
  let events: ReturnType<typeof captureEvents>

  beforeEach(() => {
    events = captureEvents()
  })

  test("BLOCKED: no domain event is emitted yet", async () => {
    // `@yourcrm/events` has no CustomObjectEvents group and this module may
    // neither add one nor emit a string literal, so spec 33's
    // custom_object.created / custom_field.created / schema.updated are not
    // emitted. This test pins that so the gap stays visible and so adding
    // the constants is a deliberate, test-updating change.
    const h = setup()
    try {
      await seedObject(h)
      await h.service.createRecord(h.ctx, "deal-room", { values: { title: "Acme" } })
      expect(events.count()).toBe(0)
    } finally {
      events.release()
    }
  })
})
