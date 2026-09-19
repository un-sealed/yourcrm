import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@yourcrm/auth"
import { createFormsService, type FormsService } from "@yourcrm/crm/src/forms"
import type {
  FormFieldRecord,
  FormsStore,
  FormRecord,
  FormSubmissionRecord,
} from "@yourcrm/crm/src/forms"
import {
  createApiClient,
  createStore,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
import type { BaseRecord } from "@yourcrm/validation"
import { Hono } from "hono"
import type { AppEnv } from "../../hono-env"
import { createRoutes, resetSubmitRateLimits } from "./forms"

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
}

function asRecord(row: StoredForm): FormRecord {
  return row as unknown as FormRecord
}

/** Real domain service over a hermetic in-memory store. */
function makeFakeService() {
  const forms = createStore<StoredForm>()
  const fields = createStore<StoredField>()
  const store: FormsStore = {
    list: async (workspaceId, query) => {
      const rows = forms.list(workspaceId)
      const limit = query.limit ?? 25
      const data = rows.slice(0, limit)
      return {
        data: data.map(asRecord),
        pagination: {
          nextCursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null,
          limit,
        },
      }
    },
    findById: async (workspaceId, id) => {
      const row = forms.get(id, workspaceId)
      return row ? asRecord(row) : null
    },
    findWithFields: async (workspaceId, id) => {
      const row = forms.get(id, workspaceId)
      if (!row) return null
      return {
        form: asRecord(row),
        fields: fields
          .list(workspaceId)
          .filter((f) => f.formId === id)
          .map((f) => f as unknown as FormFieldRecord),
      }
    },
    findPublicByToken: async () => null,
    findPublishedById: async () => null,
    create: async (workspaceId, input, actorId) => {
      return asRecord(
        forms.insert({
          ...makeBaseRecord({ workspaceId }),
          name: input.name as string,
          description: null,
          status: (input.status as string | null) ?? "draft",
          publicId: `public-${Math.random()}`,
          successMessage: null,
          ownerId: null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }),
      )
    },
    update: async (workspaceId, id, input) => {
      const row = forms.update(id, workspaceId, input as Partial<StoredForm>)
      return row ? asRecord(row) : null
    },
    softDelete: async (workspaceId, id) => {
      forms.remove(id, workspaceId)
    },
    restore: async (workspaceId, id) => {
      forms.restore(id, workspaceId)
    },
    addField: async (workspaceId, formId, input, actorId) => {
      const row = fields.insert({
        ...makeBaseRecord({ workspaceId }),
        formId,
        label: input.label as string,
        fieldType: (input.fieldType as string | null) ?? "text",
        required: (input.required as boolean | null) ?? false,
        position: 0,
        ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
      })
      return row as unknown as FormFieldRecord
    },
    updateField: async () => null,
    removeField: async () => undefined,
    reorderFields: async () => [],
    createSubmission: async (workspaceId, formId, input) => {
      return {
        id: `sub-${Math.random()}`,
        workspaceId,
        formId,
        values: input.values,
      } as unknown as FormSubmissionRecord
    },
    listSubmissions: async () => ({ data: [], pagination: { nextCursor: null, limit: 25 } }),
  }
  return createFormsService({ store, audit: async () => undefined })
}

/**
 * Hermetic API test: the route factory takes a service, so tests inject the
 * real domain service over an in-memory store. Sessions ride a tiny test-only
 * middleware (role-accurate without touching the foundation auth hook).
 */
function makeTestApp(session: { current: Session | null }, service: FormsService) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("session", session.current)
    await next()
  })
  app.route("/api/v1/forms", createRoutes({ service }))
  return app
}

describe("api/forms", () => {
  let session: { current: Session | null }
  let service: FormsService
  let ctx: ReturnType<typeof makeServiceContext>

  beforeEach(() => {
    const owner = makeSession({ role: "owner" })
    ctx = makeServiceContext({ session: owner })
    session = { current: owner }
    service = makeFakeService()
    resetSubmitRateLimits()
  })

  test("unauthenticated staff requests get UNAUTHORIZED", async () => {
    session.current = null
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/forms")
    expect(res.status).toBe(401)
    res.expectError("UNAUTHORIZED")
  })

  test("list returns the cursor pagination envelope", async () => {
    await service.create(ctx, { name: "Contact us" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.get("/api/v1/forms")
    expect(res.status).toBe(200)
    const body = res.expectSuccess()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toEqual({ nextCursor: null, limit: 25 })
  })

  test("get returns the form with fields; unknown id is NOT_FOUND", async () => {
    const created = await service.create(ctx, { name: "Contact us" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const ok = await api.get(`/api/v1/forms/${created.id}`)
    expect(ok.status).toBe(200)
    const data = ok.expectSuccess().data as { id: string; fields: unknown[] }
    expect(data.id).toBe(created.id)
    expect(data.fields).toEqual([])
    const missing = await api.get("/api/v1/forms/does-not-exist")
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
  })

  test("create validates the body and returns 201", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    const bad = await api.post("/api/v1/forms", { name: "  " })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
    const good = await api.post("/api/v1/forms", { name: "Contact us" })
    expect(good.status).toBe(201)
    expect((good.expectSuccess().data as { name: string }).name).toBe("Contact us")
  })

  test("viewer create is FORBIDDEN (service denial maps to 403)", async () => {
    session.current = makeSession({ role: "viewer", workspaceId: ctx.workspaceId })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const res = await api.post("/api/v1/forms", { name: "Nope" })
    expect(res.status).toBe(403)
    const err = res.expectError("FORBIDDEN")
    expect(err.error.message).toContain("create")
  })

  test("update, delete and restore round-trip", async () => {
    const created = await service.create(ctx, { name: "Contact us" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const patched = await api.patch(`/api/v1/forms/${created.id}`, { description: "Hello" })
    expect(patched.status).toBe(200)
    const deleted = await api.delete(`/api/v1/forms/${created.id}`)
    expect(deleted.status).toBe(200)
    const gone = await api.get(`/api/v1/forms/${created.id}`)
    expect(gone.status).toBe(404)
    const restored = await api.post(`/api/v1/forms/${created.id}/restore`)
    expect(restored.status).toBe(200)
    const back = await api.get(`/api/v1/forms/${created.id}`)
    expect(back.status).toBe(200)
  })

  test("field builder add round-trips through the route", async () => {
    const created = await service.create(ctx, { name: "Contact us" })
    const api = createApiClient({ app: makeTestApp(session, service) })
    const added = await api.post(`/api/v1/forms/${created.id}/fields`, {
      label: "Email",
      fieldType: "email",
      required: true,
    })
    expect(added.status).toBe(201)
    expect((added.expectSuccess().data as { label: string }).label).toBe("Email")
    const bad = await api.post(`/api/v1/forms/${created.id}/fields`, {
      label: "Nope",
      fieldType: "carrier-pigeon",
    })
    expect(bad.status).toBe(400)
    bad.expectError("VALIDATION_ERROR")
  })

  test("public submit works without a session and is rate-limited", async () => {
    const api = createApiClient({ app: makeTestApp(session, service) })
    // Fake store has no published forms, so an unknown id is NOT_FOUND —
    // the point here is the endpoint is reachable without auth (not 401).
    const missing = await api.post("/api/v1/forms/does-not-exist/submit", { values: {} })
    expect(missing.status).toBe(404)
    missing.expectError("NOT_FOUND")
    // Exhaust the window (30 allowed), then the next submit is 429.
    for (let i = 0; i < 30; i += 1) {
      await api.post("/api/v1/forms/does-not-exist/submit", { values: {} })
    }
    const limited = await api.post("/api/v1/forms/does-not-exist/submit", { values: {} })
    expect(limited.status).toBe(429)
    limited.expectError("RATE_LIMITED")
  })
})
