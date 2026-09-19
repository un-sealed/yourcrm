import { and, asc, eq, ilike, isNull, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  formFields,
  forms,
  formSubmissions,
  isFormFieldType,
  isFormStatus,
  type Form,
  type FormField,
  type FormSubmission,
  type NewForm,
} from "../schema/forms"
import { createBaseRepository } from "./base-repository"

export type CreateFormInput = {
  name: string
  description?: string | null
  status?: string | null
  publicId?: string | null
  successMessage?: string | null
  ownerId?: string | null
  fields?: CreateFormFieldInput[]
}

export type UpdateFormInput = Partial<
  Pick<NewForm, "name" | "description" | "status" | "publicId" | "successMessage" | "ownerId">
>

export type CreateFormFieldInput = {
  label: string
  fieldType?: string | null
  required?: boolean | null
  position?: number | null
  placeholder?: string | null
  options?: string[] | null
  helpText?: string | null
}

export type UpdateFormFieldInput = Partial<
  Pick<
    CreateFormFieldInput,
    "label" | "fieldType" | "required" | "position" | "placeholder" | "options" | "helpText"
  >
>

export type CreateSubmissionInput = {
  values: Record<string, unknown>
  submitterEmail?: string | null
  ipHash?: string | null
  userAgent?: string | null
}

export type FormWithFields = {
  form: Form
  fields: FormField[]
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Trimmed, non-empty label or name (max 255, mirrors the column). */
export function normalizeFormText(value: string, field: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new Error(`forms.create: ${field} must not be empty`)
  if (trimmed.length > 255) throw new Error(`forms.create: ${field} must be at most 255 characters`)
  return trimmed
}

export function validateSubmissionEmail(email: string): string {
  const trimmed = email.trim().toLowerCase()
  if (!EMAIL_RE.test(trimmed)) throw new Error("forms.submit: email must be a valid address")
  if (trimmed.length > 320) throw new Error("forms.submit: email must be at most 320 characters")
  return trimmed
}

function toFormValues(
  workspaceId: string,
  input: CreateFormInput | UpdateFormInput,
  actorId?: string,
): Partial<NewForm> {
  const values: Partial<NewForm> = {}
  if (input.name !== undefined) values.name = normalizeFormText(input.name, "name")
  if (input.description !== undefined) values.description = input.description?.trim() || null
  if (input.status !== undefined) {
    if (input.status !== null && !isFormStatus(input.status)) {
      throw new Error(`forms.create: status must be one of draft, published, archived`)
    }
    values.status = input.status ?? "draft"
  }
  if (input.publicId !== undefined) {
    values.publicId = input.publicId === null ? undefined : input.publicId.trim() || undefined
  }
  if (input.successMessage !== undefined)
    values.successMessage = input.successMessage?.trim() || null
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (actorId !== undefined) {
    values.updatedBy = actorId
  }
  return { ...values, workspaceId }
}

function toFieldValues(
  workspaceId: string,
  formId: string,
  input: CreateFormFieldInput | UpdateFormFieldInput,
  actorId?: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = { workspaceId, formId }
  if (input.label !== undefined) values.label = normalizeFormText(input.label, "label")
  if (input.fieldType !== undefined) {
    if (input.fieldType !== null && !isFormFieldType(input.fieldType)) {
      throw new Error(
        `forms.fields: fieldType must be one of text, email, phone, number, textarea, select, checkbox, date`,
      )
    }
    values.fieldType = input.fieldType ?? "text"
  }
  if (input.required !== undefined) values.required = input.required ?? false
  if (input.position !== undefined) values.position = input.position ?? 0
  if (input.placeholder !== undefined) values.placeholder = input.placeholder?.trim() || null
  if (input.options !== undefined) {
    if (input.options !== null) {
      const cleaned = input.options.map((o) => o.trim()).filter((o) => o !== "")
      if (cleaned.length === 0) throw new Error("forms.fields: options must not be empty")
      values.options = cleaned
    } else {
      values.options = null
    }
  }
  if (input.helpText !== undefined) values.helpText = input.helpText?.trim() || null
  if (actorId !== undefined) {
    values.updatedBy = actorId
  }
  return values
}

function randomPublicId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let out = ""
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return out
}

/**
 * Workspace-scoped forms + ordered fields + submissions. `leadId` on
 * submissions stays a plain column (no join here) until the leads module
 * lands; tags and relationships attach via the shared repositories.
 */
export function createFormsRepository() {
  const base = createBaseRepository(forms)
  const submissionsBase = createBaseRepository(formSubmissions)

  async function liveFields(
    db: Database,
    workspaceId: string,
    formId: string,
  ): Promise<FormField[]> {
    return db
      .select()
      .from(formFields)
      .where(
        and(
          eq(formFields.formId, formId),
          eq(formFields.workspaceId, workspaceId),
          isNull(formFields.deletedAt),
        ),
      )
      .orderBy(asc(formFields.position), asc(formFields.createdAt))
  }

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateFormInput,
      actorId?: string,
    ): Promise<Form> {
      const rows = await db
        .insert(forms)
        .values({
          ...toFormValues(workspaceId, input, actorId),
          workspaceId,
          name: normalizeFormText(input.name, "name"),
          publicId: input.publicId?.trim() || randomPublicId(),
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("forms.create: insert returned no rows")
      const fields = input.fields ?? []
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index]
        if (!field) continue
        await db.insert(formFields).values({
          ...toFieldValues(workspaceId, row.id, { ...field, position: field.position ?? index }),
          workspaceId,
          formId: row.id,
          label: normalizeFormText(field.label, "label"),
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
      }
      return row
    },

    /** Cursor-paginated list with optional case-insensitive name/status search. */
    async search(
      db: Database,
      opts: { workspaceId: string; limit?: number; cursor?: string; order?: "asc" | "desc" } & {
        query?: string
        status?: string
      },
    ) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const nameMatch = or(ilike(forms.name, q), ilike(forms.description, q))
        if (nameMatch) conditions.push(nameMatch)
      }
      if (opts.status) {
        if (!isFormStatus(opts.status)) throw new Error("forms.search: unknown status filter")
        conditions.push(eq(forms.status, opts.status))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as Form[], pagination: result.pagination }
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateFormInput,
      actorId?: string,
    ): Promise<Form | null> {
      const rows = await db
        .update(forms)
        .set({ ...toFormValues(workspaceId, input, actorId), updatedAt: new Date() })
        .where(and(eq(forms.id, id), eq(forms.workspaceId, workspaceId), isNull(forms.deletedAt)))
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<Form | null> {
      // The shared base narrows rows to the BaseRecord columns; re-select the
      // concrete table here so callers get the full Form shape.
      const row = await base.findById(db, workspaceId, id)
      return (row as Form | null) ?? null
    },

    async findWithFields(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<FormWithFields | null> {
      const form = await this.findById(db, workspaceId, id)
      if (!form) return null
      const fields = await liveFields(db, workspaceId, id)
      return { form, fields }
    },

    /** Public lookup by share token: published, non-deleted forms only. */
    async findPublicByToken(db: Database, publicId: string): Promise<FormWithFields | null> {
      const rows = await db
        .select()
        .from(forms)
        .where(
          and(eq(forms.publicId, publicId), eq(forms.status, "published"), isNull(forms.deletedAt)),
        )
        .limit(1)
      const form = rows[0]
      if (!form) return null
      const fields = await liveFields(db, form.workspaceId, form.id)
      return { form, fields }
    },

    /** Published-form lookup by id for the unauthenticated submit path. */
    async findPublishedById(db: Database, id: string): Promise<FormWithFields | null> {
      const rows = await db
        .select()
        .from(forms)
        .where(and(eq(forms.id, id), eq(forms.status, "published"), isNull(forms.deletedAt)))
        .limit(1)
      const form = rows[0]
      if (!form) return null
      const fields = await liveFields(db, form.workspaceId, form.id)
      return { form, fields }
    },

    async addField(
      db: Database,
      workspaceId: string,
      formId: string,
      input: CreateFormFieldInput,
      actorId?: string,
    ): Promise<FormField> {
      const form = await this.findById(db, workspaceId, formId)
      if (!form) throw new Error(`forms.fields: form ${formId} not found`)
      const siblings = await liveFields(db, workspaceId, formId)
      const position = input.position ?? siblings.length
      const rows = await db
        .insert(formFields)
        .values({
          ...toFieldValues(workspaceId, formId, input, actorId),
          workspaceId,
          formId,
          label: normalizeFormText(input.label, "label"),
          position,
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("forms.fields: insert returned no rows")
      return row
    },

    async updateField(
      db: Database,
      workspaceId: string,
      formId: string,
      fieldId: string,
      input: UpdateFormFieldInput,
      actorId?: string,
    ): Promise<FormField | null> {
      const rows = await db
        .update(formFields)
        .set({ ...toFieldValues(workspaceId, formId, input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(formFields.id, fieldId),
            eq(formFields.formId, formId),
            eq(formFields.workspaceId, workspaceId),
            isNull(formFields.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async removeField(
      db: Database,
      workspaceId: string,
      formId: string,
      fieldId: string,
    ): Promise<void> {
      await db
        .update(formFields)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(formFields.id, fieldId),
            eq(formFields.formId, formId),
            eq(formFields.workspaceId, workspaceId),
            isNull(formFields.deletedAt),
          ),
        )
    },

    /** Persist a full field ordering (array of field ids in position order). */
    async reorderFields(
      db: Database,
      workspaceId: string,
      formId: string,
      orderedIds: string[],
    ): Promise<FormField[]> {
      for (let position = 0; position < orderedIds.length; position += 1) {
        const fieldId = orderedIds[position]
        if (!fieldId) continue
        await db
          .update(formFields)
          .set({ position, updatedAt: new Date() })
          .where(
            and(
              eq(formFields.id, fieldId),
              eq(formFields.formId, formId),
              eq(formFields.workspaceId, workspaceId),
              isNull(formFields.deletedAt),
            ),
          )
      }
      return liveFields(db, workspaceId, formId)
    },

    async createSubmission(
      db: Database,
      workspaceId: string,
      formId: string,
      input: CreateSubmissionInput,
      actorId?: string,
    ): Promise<FormSubmission> {
      const rows = await db
        .insert(formSubmissions)
        .values({
          workspaceId,
          formId,
          values: input.values,
          submitterEmail: input.submitterEmail ?? null,
          ipHash: input.ipHash ?? null,
          userAgent: input.userAgent ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("forms.submit: insert returned no rows")
      return row
    },

    /** Cursor-paginated submissions for one form (newest first by default). */
    async listSubmissions(
      db: Database,
      opts: { workspaceId: string; formId: string; limit?: number; cursor?: string },
    ) {
      const result = await submissionsBase.list(db, {
        workspaceId: opts.workspaceId,
        limit: opts.limit,
        cursor: opts.cursor,
        where: [eq(formSubmissions.formId, opts.formId)],
      })
      return { data: result.data as FormSubmission[], pagination: result.pagination }
    },
  }
}

export type FormsRepository = ReturnType<typeof createFormsRepository>
