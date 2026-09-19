import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"
import { FormEvents, createEvent, getEventBus } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import type {
  FormFieldRecord,
  FormRecord,
  FormsServiceContext,
  FormsServiceDeps,
  FormSubmissionRecord,
  FormWithFields,
} from "./types"

// ---------------------------------------------------------------------------
// Zod schemas. Services validate inputs with these; API routes reuse them at
// the HTTP boundary via `@hono/zod-validator` (same split as people).
// (Kept in service.ts because this module's file grant covers
// index/service/types/test only.)
// ---------------------------------------------------------------------------

const nameSchema = z.string().trim().min(1).max(255)

export const formFieldTypeSchema = z.enum([
  "text",
  "email",
  "phone",
  "number",
  "textarea",
  "select",
  "checkbox",
  "date",
])

export const formStatusSchema = z.enum(["draft", "published", "archived"])

export const formFieldInputSchema = z.object({
  label: nameSchema,
  fieldType: formFieldTypeSchema.nullish(),
  required: z.boolean().nullish(),
  position: z.number().int().min(0).max(1000).nullish(),
  placeholder: z.string().trim().max(255).nullish(),
  options: z.array(z.string().trim().min(1).max(255)).max(50).nullish(),
  helpText: z.string().trim().max(2000).nullish(),
})

export const createFormSchema = z.object({
  name: nameSchema,
  description: z.string().trim().max(10000).nullish(),
  status: formStatusSchema.nullish(),
  publicId: z.string().trim().min(8).max(64).nullish(),
  successMessage: z.string().trim().max(2000).nullish(),
  ownerId: z.string().min(1).nullish(),
  fields: z.array(formFieldInputSchema).max(100).default([]),
})

export type CreateFormInput = z.infer<typeof createFormSchema>

export const updateFormSchema = createFormSchema
  .omit({ fields: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateFormInput = z.infer<typeof updateFormSchema>

export const updateFormFieldSchema = formFieldInputSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export const reorderFormFieldsSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1).max(200),
})

export const formQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: formStatusSchema.optional(),
})

export type FormQuery = z.infer<typeof formQuerySchema>

export const submissionQuerySchema = paginationQuerySchema.omit({ sort: true, order: true })

export const submitFormSchema = z.object({
  values: z.record(z.string(), z.unknown()),
  submitterEmail: z.string().trim().email().max(320).nullish(),
})

export type SubmitFormInput = z.infer<typeof submitFormSchema>

export const formSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  status: z.string(),
  publicId: z.string(),
  successMessage: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type FormDto = z.infer<typeof formSchema>

export const formFieldSchema = z.object({
  id: z.string(),
  formId: z.string(),
  label: z.string(),
  fieldType: z.string(),
  required: z.boolean(),
  position: z.number(),
  placeholder: z.string().nullable().optional(),
  options: z.array(z.string()).nullable().optional(),
  helpText: z.string().nullable().optional(),
})

export type FormFieldDto = z.infer<typeof formFieldSchema>

export const formSubmissionSchema = z.object({
  id: z.string(),
  formId: z.string(),
  values: z.record(z.string(), z.unknown()),
  submitterEmail: z.string().nullable().optional(),
  leadId: z.string().nullable().optional(),
  createdAt: z.unknown(),
})

export type FormSubmissionDto = z.infer<typeof formSubmissionSchema>

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FormNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`form ${id} not found`)
    this.name = "FormNotFoundError"
  }
}

export class FormNotPublishedError extends Error {
  readonly code = "FORM_NOT_PUBLISHED"
  constructor(id: string) {
    super(`form ${id} is not published`)
    this.name = "FormNotPublishedError"
  }
}

export class FormFieldNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`form field ${id} not found`)
    this.name = "FormFieldNotFoundError"
  }
}

function permissionOf(ctx: FormsServiceContext, action: "read" | "create" | "update" | "delete") {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "form",
    action,
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "")
}

/**
 * Validate a public submission payload against the form's live field
 * definitions: required flags, email shape, select options. Returns the
 * normalized values (trimmed strings) or throws a validation Error.
 */
export function validateSubmissionValues(
  fields: FormFieldRecord[],
  rawValues: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const field of fields) {
    const fieldId = String(field.id)
    const label = String(field.label ?? fieldId)
    const fieldType = String(field.fieldType ?? "text")
    const required = field.required === true
    const raw = rawValues[fieldId]
    if (isEmptyValue(raw)) {
      if (required) throw new Error(`forms.submit: "${label}" is required`)
      continue
    }
    if (typeof raw === "string") {
      const trimmed = raw.trim()
      if (fieldType === "email" && !EMAIL_RE.test(trimmed)) {
        throw new Error(`forms.submit: "${label}" must be a valid email address`)
      }
      if (fieldType === "number" && trimmed !== "" && Number.isNaN(Number(trimmed))) {
        throw new Error(`forms.submit: "${label}" must be a number`)
      }
      if (fieldType === "select" && Array.isArray(field.options)) {
        const options = field.options.map((o) => String(o))
        if (!options.includes(trimmed)) {
          throw new Error(`forms.submit: "${label}" must be one of ${options.join(", ")}`)
        }
      }
      values[fieldId] = trimmed
    } else if (typeof raw === "boolean") {
      if (fieldType === "checkbox" && required && raw !== true) {
        throw new Error(`forms.submit: "${label}" is required`)
      }
      values[fieldId] = raw
    } else if (typeof raw === "number") {
      values[fieldId] = raw
    } else {
      values[fieldId] = raw
    }
  }
  return values
}

/**
 * Forms domain service (mirrors the people reference).
 *
 * Every staff-facing method:
 *  1. calls `requirePermission()` FIRST, before any read or write;
 *  2. does the work through the injected `FormsStore` port;
 *  3. emits the domain event via the `FormEvents` constant (never a literal);
 *  4. writes the audit row with before/after (mutations only).
 *
 * `getPublic` / `submit` are the unauthenticated embed endpoints: there is no
 * actor, so instead of a role check they gate on the form being `published`.
 */
export function createFormsService(deps: FormsServiceDeps) {
  const events = deps.events ?? getEventBus()

  async function list(ctx: FormsServiceContext, rawQuery: unknown) {
    requirePermission(permissionOf(ctx, "read"))
    const query = formQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(ctx: FormsServiceContext, id: string): Promise<FormWithFields> {
    requirePermission(permissionOf(ctx, "read"))
    const found = await deps.store.findWithFields(ctx.workspaceId, id)
    if (!found) throw new FormNotFoundError(id)
    return found
  }

  async function create(ctx: FormsServiceContext, rawInput: unknown): Promise<FormRecord> {
    requirePermission(permissionOf(ctx, "create"))
    const input = createFormSchema.parse(rawInput)
    const form = await deps.store.create(
      ctx.workspaceId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await events.emit(
      createEvent({
        event: FormEvents.FormCreated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "form",
        entityId: form.id,
        after: form,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: "form",
      recordId: form.id,
      after: form,
      correlationId: ctx.correlationId,
    })
    return form
  }

  async function update(
    ctx: FormsServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<FormRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateFormSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new FormNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new FormNotFoundError(id)
    await events.emit(
      createEvent({
        event: FormEvents.FormUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "form",
        entityId: id,
        before,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "form",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function softDelete(ctx: FormsServiceContext, id: string): Promise<FormRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new FormNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    // No FormDeleted constant is exported by @yourcrm/events; deletions ride
    // the FormUpdated event with a delete audit action (see report).
    await events.emit(
      createEvent({
        event: FormEvents.FormUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "form",
        entityId: id,
        before,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "form",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(ctx: FormsServiceContext, id: string): Promise<FormRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new FormNotFoundError(id)
    await events.emit(
      createEvent({
        event: FormEvents.FormUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "form",
        entityId: id,
        after,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "form",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function emitFieldsChanged(
    ctx: FormsServiceContext,
    formId: string,
    before: FormWithFields | null,
  ): Promise<FormWithFields> {
    const after = await deps.store.findWithFields(ctx.workspaceId, formId)
    if (!after) throw new FormNotFoundError(formId)
    await events.emit(
      createEvent({
        event: FormEvents.FormUpdated,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: "form",
        entityId: formId,
        before: before?.fields ?? null,
        after: after.fields,
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "form_field",
      recordId: formId,
      before: before?.fields ?? null,
      after: after.fields,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function addField(
    ctx: FormsServiceContext,
    formId: string,
    rawInput: unknown,
  ): Promise<FormFieldRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const input = formFieldInputSchema.parse(rawInput)
    const before = await deps.store.findWithFields(ctx.workspaceId, formId)
    if (!before) throw new FormNotFoundError(formId)
    const field = await deps.store.addField(
      ctx.workspaceId,
      formId,
      input as Record<string, unknown>,
      ctx.actorId,
    )
    await emitFieldsChanged(ctx, formId, before)
    return field
  }

  async function updateField(
    ctx: FormsServiceContext,
    formId: string,
    fieldId: string,
    rawPatch: unknown,
  ): Promise<FormFieldRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateFormFieldSchema.parse(rawPatch)
    const before = await deps.store.findWithFields(ctx.workspaceId, formId)
    if (!before) throw new FormNotFoundError(formId)
    const after = await deps.store.updateField(
      ctx.workspaceId,
      formId,
      fieldId,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new FormFieldNotFoundError(fieldId)
    await emitFieldsChanged(ctx, formId, before)
    return after
  }

  async function removeField(
    ctx: FormsServiceContext,
    formId: string,
    fieldId: string,
  ): Promise<void> {
    requirePermission(permissionOf(ctx, "update"))
    const before = await deps.store.findWithFields(ctx.workspaceId, formId)
    if (!before) throw new FormNotFoundError(formId)
    if (!before.fields.some((f) => f.id === fieldId)) throw new FormFieldNotFoundError(fieldId)
    await deps.store.removeField(ctx.workspaceId, formId, fieldId)
    await emitFieldsChanged(ctx, formId, before)
  }

  async function reorderFields(
    ctx: FormsServiceContext,
    formId: string,
    rawInput: unknown,
  ): Promise<FormFieldRecord[]> {
    requirePermission(permissionOf(ctx, "update"))
    const { orderedIds } = reorderFormFieldsSchema.parse(rawInput)
    const before = await deps.store.findWithFields(ctx.workspaceId, formId)
    if (!before) throw new FormNotFoundError(formId)
    const known = new Set(before.fields.map((f) => f.id))
    for (const id of orderedIds) {
      if (!known.has(id)) throw new FormFieldNotFoundError(id)
    }
    const fields = await deps.store.reorderFields(ctx.workspaceId, formId, orderedIds)
    await emitFieldsChanged(ctx, formId, before)
    return fields
  }

  /** Public embed lookup by share token. Published forms only, no actor. */
  async function getPublic(publicId: string): Promise<FormWithFields> {
    const found = await deps.store.findPublicByToken(publicId)
    if (!found) throw new FormNotFoundError(publicId)
    return found
  }

  /**
   * Public submission. No actor exists, so the published-status gate is the
   * authorization (draft/archived/deleted forms reject with 404-equivalent).
   * Rate limiting lives in the route layer, which has the caller IP.
   */
  async function submit(
    formId: string,
    rawInput: unknown,
    meta?: { ipHash?: string; userAgent?: string; correlationId?: string },
  ): Promise<FormSubmissionRecord> {
    const input = submitFormSchema.parse(rawInput)
    const found = await deps.store.findPublishedById(formId)
    if (!found) throw new FormNotFoundError(formId)
    const values = validateSubmissionValues(found.fields, input.values)
    const submission = await deps.store.createSubmission(found.form.workspaceId, found.form.id, {
      values,
      submitterEmail: input.submitterEmail ?? null,
      ipHash: meta?.ipHash,
      userAgent: meta?.userAgent,
    })
    await events.emit(
      createEvent({
        event: FormEvents.FormSubmitted,
        workspaceId: found.form.workspaceId,
        entityType: "form_submission",
        entityId: submission.id,
        after: submission,
        correlationId: meta?.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: found.form.workspaceId,
      action: "submit",
      object: "form_submission",
      recordId: submission.id,
      after: submission,
      correlationId: meta?.correlationId,
    })
    return submission
  }

  async function listSubmissions(ctx: FormsServiceContext, formId: string, rawQuery: unknown) {
    requirePermission(permissionOf(ctx, "read"))
    const query = submissionQuerySchema.parse(rawQuery)
    const form = await deps.store.findById(ctx.workspaceId, formId)
    if (!form) throw new FormNotFoundError(formId)
    return deps.store.listSubmissions(ctx.workspaceId, formId, query)
  }

  return {
    list,
    get,
    create,
    update,
    softDelete,
    restore,
    addField,
    updateField,
    removeField,
    reorderFields,
    getPublic,
    submit,
    listSubmissions,
  }
}

export type FormsService = ReturnType<typeof createFormsService>
