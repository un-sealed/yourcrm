import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"

/**
 * Forms service ports (mirrors the people module pattern).
 *
 * `@yourcrm/crm` has no database dependency, so the service never imports
 * `@yourcrm/database`. It depends on these structural ports instead; the API
 * layer adapts the drizzle repository (`forms-repository.ts`) and
 * `writeAudit` to them. Any object with matching methods satisfies the
 * port — including the `createStore` fake in hermetic tests.
 */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type FormRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
}

export type FormFieldRecord = Record<string, unknown> & {
  id: string
  formId: string
}

export type FormSubmissionRecord = Record<string, unknown> & {
  id: string
  formId: string
}

export type FormWithFields = {
  form: FormRecord
  fields: FormFieldRecord[]
}

export type FormListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
}

export type FormListResult = {
  data: FormRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type SubmissionListQuery = {
  limit?: number
  cursor?: string
}

export type SubmissionListResult = {
  data: FormSubmissionRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type FormsStore = {
  list(workspaceId: string, query: FormListQuery): Promise<FormListResult>
  findById(workspaceId: string, id: string): Promise<FormRecord | null>
  findWithFields(workspaceId: string, id: string): Promise<FormWithFields | null>
  findPublicByToken(publicId: string): Promise<FormWithFields | null>
  findPublishedById(id: string): Promise<FormWithFields | null>
  create(workspaceId: string, input: Record<string, unknown>, actorId?: string): Promise<FormRecord>
  update(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<FormRecord | null>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
  addField(
    workspaceId: string,
    formId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<FormFieldRecord>
  updateField(
    workspaceId: string,
    formId: string,
    fieldId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<FormFieldRecord | null>
  removeField(workspaceId: string, formId: string, fieldId: string): Promise<void>
  reorderFields(
    workspaceId: string,
    formId: string,
    orderedIds: string[],
  ): Promise<FormFieldRecord[]>
  createSubmission(
    workspaceId: string,
    formId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<FormSubmissionRecord>
  listSubmissions(
    workspaceId: string,
    formId: string,
    query: SubmissionListQuery,
  ): Promise<SubmissionListResult>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type FormAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type FormsServiceContext = ServiceContext

export type FormsServiceDeps = {
  store: FormsStore
  audit: AuditWriter<FormAuditInput>
  events?: EventEmitter
}
