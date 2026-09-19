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
  createFormsService,
  type FormsService,
  type FormFieldRecord,
  type FormRecord,
  type FormSubmissionRecord,
  type FormWithFields,
} from "./index"
import type { FormAuditInput, FormListQuery, FormsStore, SubmissionListQuery } from "./types"

type StoredForm = BaseRecord & {
  name: string
  description: string | null
  status: string
  publicId: string
  successMessage: string | null
  ownerId: string | null
}

type StoredField = BaseRecord & {
  formId: string
  label: string
  fieldType: string
  required: boolean
  position: number
  placeholder: string | null
  options: string[] | null
  helpText: string | null
}

type StoredSubmission = BaseRecord & {
  formId: string
  values: Record<string, unknown>
  submitterEmail: string | null
  leadId: string | null
}

function asForm(row: StoredForm): FormRecord {
  return row as unknown as FormRecord
}

function asField(row: StoredField): FormFieldRecord {
  return row as unknown as FormFieldRecord
}

function asSubmission(row: StoredSubmission): FormSubmissionRecord {
  return row as unknown as FormSubmissionRecord
}

/** Hermetic FormsStore port backed by the shared in-memory stores. */
function makeStore() {
  const forms = createStore<StoredForm>()
  const fields = createStore<StoredField>()
  const submissions = createStore<StoredSubmission>()
  let fieldSeq = 0
  /** Registry of every inserted form id+workspace (public lookups are unscoped). */
  const allForms: { id: string; workspaceId: string }[] = []

  const liveFields = (workspaceId: string, formId: string): StoredField[] =>
    fields
      .list(workspaceId)
      .filter((f) => f.formId === formId)
      .sort((a, b) => a.position - b.position)

  const publicLookup = (predicate: (row: StoredForm) => boolean): FormWithFields | null => {
    const candidate = allForms
      .map(({ id, workspaceId }) => forms.get(id, workspaceId))
      .find((row): row is StoredForm => row !== null && predicate(row))
    if (!candidate) return null
    return {
      form: asForm(candidate),
      fields: liveFields(candidate.workspaceId, candidate.id).map(asField),
    }
  }

  const store: FormsStore = {
    list: async (workspaceId: string, query: FormListQuery) => {
      let rows = forms.list(workspaceId)
      if (query.status) rows = rows.filter((r) => r.status === query.status)
      if (query.query) {
        const q = query.query.toLowerCase()
        rows = rows.filter((r) => r.name.toLowerCase().includes(q))
      }
      const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
      const data = rows.slice(0, limit)
      return {
        data: data.map(asForm),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    findById: async (workspaceId: string, id: string) => {
      const row = forms.get(id, workspaceId)
      return row ? asForm(row) : null
    },
    findWithFields: async (workspaceId: string, id: string) => {
      const row = forms.get(id, workspaceId)
      if (!row) return null
      return { form: asForm(row), fields: liveFields(workspaceId, id).map(asField) }
    },
    findPublicByToken: async (publicId: string) =>
      publicLookup((row) => row.publicId === publicId && row.status === "published"),
    findPublishedById: async (id: string) =>
      publicLookup((row) => row.id === id && row.status === "published"),
    create: async (workspaceId: string, input: Record<string, unknown>, actorId?: string) => {
      const inserted = forms.insert({
        ...makeBaseRecord({ workspaceId }),
        name: input.name as string,
        description: (input.description as string | null) ?? null,
        status: (input.status as string | null) ?? "draft",
        publicId: (input.publicId as string | null) ?? `public-${Math.random()}`,
        successMessage: (input.successMessage as string | null) ?? null,
        ownerId: (input.ownerId as string | null) ?? null,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      })
      allForms.push({ id: inserted.id, workspaceId })
      for (const raw of (input.fields as Record<string, unknown>[] | undefined) ?? []) {
        fields.insert({
          ...makeBaseRecord({ workspaceId }),
          formId: inserted.id,
          label: raw.label as string,
          fieldType: (raw.fieldType as string | null) ?? "text",
          required: (raw.required as boolean | null) ?? false,
          position: (raw.position as number | null) ?? fieldSeq++,
          placeholder: (raw.placeholder as string | null) ?? null,
          options: (raw.options as string[] | null) ?? null,
          helpText: (raw.helpText as string | null) ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
      }
      return asForm(inserted)
    },
    update: async (workspaceId: string, id: string, input: Record<string, unknown>) => {
      const row = forms.update(id, workspaceId, input as Partial<StoredForm>)
      return row ? asForm(row) : null
    },
    softDelete: async (workspaceId: string, id: string) => {
      forms.remove(id, workspaceId)
    },
    restore: async (workspaceId: string, id: string) => {
      forms.restore(id, workspaceId)
    },
    addField: async (
      workspaceId: string,
      formId: string,
      input: Record<string, unknown>,
      actorId?: string,
    ) => {
      return asField(
        fields.insert({
          ...makeBaseRecord({ workspaceId }),
          formId,
          label: input.label as string,
          fieldType: (input.fieldType as string | null) ?? "text",
          required: (input.required as boolean | null) ?? false,
          position: (input.position as number | null) ?? liveFields(workspaceId, formId).length,
          placeholder: (input.placeholder as string | null) ?? null,
          options: (input.options as string[] | null) ?? null,
          helpText: (input.helpText as string | null) ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    updateField: async (
      workspaceId: string,
      _formId: string,
      fieldId: string,
      input: Record<string, unknown>,
    ) => {
      const row = fields.update(fieldId, workspaceId, input as Partial<StoredField>)
      return row ? asField(row) : null
    },
    removeField: async (workspaceId: string, _formId: string, fieldId: string) => {
      fields.remove(fieldId, workspaceId)
    },
    reorderFields: async (workspaceId: string, formId: string, orderedIds: string[]) => {
      orderedIds.forEach((id, position) => {
        fields.update(id, workspaceId, { position })
      })
      return liveFields(workspaceId, formId).map(asField)
    },
    createSubmission: async (
      workspaceId: string,
      formId: string,
      input: Record<string, unknown>,
    ) => {
      return asSubmission(
        submissions.insert({
          ...makeBaseRecord({ workspaceId }),
          formId,
          values: input.values as Record<string, unknown>,
          submitterEmail: (input.submitterEmail as string | null) ?? null,
          leadId: null,
        }),
      )
    },
    listSubmissions: async (workspaceId: string, formId: string, query: SubmissionListQuery) => {
      const rows = submissions.list(workspaceId).filter((r) => r.formId === formId)
      const limit = Math.min(Math.max(query.limit ?? 25, 1), 200)
      const data = rows.slice(0, limit)
      return {
        data: data.map(asSubmission),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
  }
  return { forms, fields, submissions, store }
}

function setup(
  role: "owner" | "admin" | "member" | "viewer" = "owner",
  shared?: ReturnType<typeof makeStore>,
  workspaceId?: string,
) {
  const session = makeSession({ role, ...(workspaceId === undefined ? {} : { workspaceId }) })
  const ctx = makeServiceContext({ session })
  const audits: FormAuditInput[] = []
  const backing = shared ?? makeStore()
  const service = createFormsService({
    store: backing.store,
    audit: async (input) => void audits.push(input),
  })
  return { ctx, service, audits, session, backing }
}

async function seed(service: FormsService, ctx: ServiceContext, name = "Contact us") {
  return service.create(ctx, { name })
}

describe("forms/service", () => {
  test("create validates, emits form.created and audits with after", async () => {
    const { ctx, service, audits } = setup()
    const events = captureEvents()
    try {
      const form = await expectAllowed(() => service.create(ctx, { name: "Contact us" }))
      expect(form.name).toBe("Contact us")
      events.expectEmitted("form.created", {
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "form",
        entityId: form.id,
      })
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        workspaceId: ctx.workspaceId,
        action: "create",
        object: "form",
        recordId: form.id,
      })
      expect(audits[0]?.after).toMatchObject({ name: "Contact us" })
    } finally {
      events.release()
    }
  })

  test("create rejects invalid input before touching the store", async () => {
    const { ctx, service } = setup()
    await expect(service.create(ctx, { name: "  " })).rejects.toThrow()
  })

  test("create persists ordered field definitions with type + required", async () => {
    const { ctx, service } = setup()
    const form = await expectAllowed(() =>
      service.create(ctx, {
        name: "Signup",
        fields: [
          { label: "Email", fieldType: "email", required: true },
          { label: "Notes", fieldType: "textarea" },
        ],
      }),
    )
    const found: FormWithFields = await expectAllowed(() => service.get(ctx, form.id))
    expect(found.fields).toHaveLength(2)
    expect(found.fields[0]).toMatchObject({ label: "Email", fieldType: "email", required: true })
    expect(found.fields[1]).toMatchObject({ label: "Notes", fieldType: "textarea" })
  })

  test("get returns the form with fields, list paginates", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const found = await expectAllowed(() => service.get(ctx, created.id))
    expect(found.form.id).toBe(created.id)
    expect(found.fields).toEqual([])
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

  test("update emits form.updated and audits with before/after", async () => {
    const { ctx, service, audits } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      const updated = await expectAllowed(() =>
        service.update(ctx, created.id, { description: "Hello" }),
      )
      expect(updated.description).toBe("Hello")
      const emitted = events.expectEmitted("form.updated", { entityId: created.id })
      expect(emitted.before).toMatchObject({ description: null })
      expect(emitted.after).toMatchObject({ description: "Hello" })
      expect(audits.at(-1)).toMatchObject({ action: "update", recordId: created.id })
    } finally {
      events.release()
    }
  })

  test("softDelete emits form.updated and hides the row; restore revives it", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const events = captureEvents()
    try {
      await expectAllowed(() => service.softDelete(ctx, created.id))
      events.expectEmitted("form.updated", { entityId: created.id })
      await expect(service.get(ctx, created.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
      const restored = await expectAllowed(() => service.restore(ctx, created.id))
      expect(restored.id).toBe(created.id)
      await expectAllowed(() => service.get(ctx, created.id))
    } finally {
      events.release()
    }
  })

  test("field builder add/update/remove/reorder round-trips in position order", async () => {
    const { ctx, service } = setup()
    const created = await seed(service, ctx)
    const first = await expectAllowed(() =>
      service.addField(ctx, created.id, { label: "Email", fieldType: "email", required: true }),
    )
    const second = await expectAllowed(() =>
      service.addField(ctx, created.id, { label: "Name", fieldType: "text" }),
    )
    await expectAllowed(() => service.updateField(ctx, created.id, second.id, { required: true }))
    const reordered = await expectAllowed(() =>
      service.reorderFields(ctx, created.id, { orderedIds: [second.id, first.id] }),
    )
    expect(reordered.map((f) => f.id)).toEqual([second.id, first.id])
    await expectAllowed(() => service.removeField(ctx, created.id, first.id))
    const found = await expectAllowed(() => service.get(ctx, created.id))
    expect(found.fields.map((f) => f.id)).toEqual([second.id])
  })

  test("submit validates required fields and emits form.submitted", async () => {
    const { ctx, service } = setup()
    const created = await expectAllowed(() =>
      service.create(ctx, {
        name: "Signup",
        status: "published",
        fields: [{ label: "Email", fieldType: "email", required: true }],
      }),
    )
    const withFields = await expectAllowed(() => service.get(ctx, created.id))
    const emailField = withFields.fields[0]
    if (!emailField) throw new Error("expected a field")
    const events = captureEvents()
    try {
      await expect(service.submit(created.id, { values: {} })).rejects.toThrow(/required/)
      await expect(
        service.submit(created.id, { values: { [emailField.id]: "not-an-email" } }),
      ).rejects.toThrow(/email/)
      const submission = await service.submit(created.id, {
        values: { [emailField.id]: " Ada@Example.com ".trim() },
        submitterEmail: "ada@example.com",
      })
      expect(submission.formId).toBe(created.id)
      events.expectEmitted("form.submitted", { entityId: submission.id })
      const inbox = await expectAllowed(() => service.listSubmissions(ctx, created.id, {}))
      expect(inbox.data).toHaveLength(1)
    } finally {
      events.release()
    }
  })

  test("submit rejects drafts and unknown forms", async () => {
    const { ctx, service } = setup()
    const draft = await seed(service, ctx)
    await expect(service.submit(draft.id, { values: {} })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(service.submit("missing", { values: {} })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  test("getPublic resolves published forms by share token only", async () => {
    const { ctx, service } = setup()
    const published = await expectAllowed(() =>
      service.create(ctx, { name: "Live", status: "published", publicId: "share-token-123" }),
    )
    const found = await service.getPublic("share-token-123")
    expect(found.form.id).toBe(published.id)
    await expect(service.getPublic("nope")).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expectAllowed(() => service.update(ctx, published.id, { status: "draft" }))
    await expect(service.getPublic("share-token-123")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  describe("denials", () => {
    let backing: ReturnType<typeof makeStore>
    let workspaceId: string
    let formId: string

    function asRole(role: "owner" | "admin" | "member" | "viewer") {
      return setup(role, backing, workspaceId)
    }

    beforeEach(async () => {
      backing = makeStore()
      const owner = setup("owner", backing)
      workspaceId = owner.ctx.workspaceId
      formId = (await seed(owner.service, owner.ctx)).id
    })

    test("viewer cannot create", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.create(ctx, { name: "Nope" }))
    })

    test("viewer cannot update or manage fields", async () => {
      const { ctx, service } = asRole("viewer")
      await expectDenied(() => service.update(ctx, formId, { description: "X" }))
      await expectDenied(() => service.addField(ctx, formId, { label: "X" }))
    })

    test("member cannot delete (admin-only)", async () => {
      const { ctx, service } = asRole("member")
      await expectDenied(() => service.softDelete(ctx, formId))
    })

    test("viewer can still list, get and read submissions (read is open)", async () => {
      const { ctx, service } = asRole("viewer")
      await expectAllowed(() => service.list(ctx, {}))
      await expectAllowed(() => service.get(ctx, formId))
      await expectAllowed(() => service.listSubmissions(ctx, formId, {}))
    })
  })
})
