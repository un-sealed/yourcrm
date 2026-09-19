"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  RecordHeader,
  Select,
  Skeleton,
  Tabs,
  TextArea,
  TextField,
  Timeline,
  toast,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  FORM_STATUS_TONES,
  type FormDetail,
  type FormField,
  type FormSubmission,
  type SubmissionsListResponse,
} from "../_components/model"

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
  { value: "archived", label: "Archived" },
]

const FIELD_TYPE_OPTIONS = [
  { value: "text", label: "Text" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "number", label: "Number" },
  { value: "textarea", label: "Long text" },
  { value: "select", label: "Dropdown" },
  { value: "checkbox", label: "Checkbox" },
  { value: "date", label: "Date" },
]

const STATUS_TONES = FORM_STATUS_TONES

function submissionColumns(fieldById: Map<string, FormField>): DataTableColumn<FormSubmission>[] {
  return [
    {
      id: "createdAt",
      header: "Submitted",
      accessor: (row) => new Date(row.createdAt).toLocaleString(),
    },
    {
      id: "submitterEmail",
      header: "Email",
      accessor: (row) => row.submitterEmail ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: "values",
      header: "Answers",
      accessor: (row) => {
        const entries = Object.entries(row.values)
        if (entries.length === 0) return <span className="text-muted-foreground">—</span>
        return (
          <span className="block max-w-md truncate text-sm">
            {entries
              .map(([fieldId, value]) => {
                const label = fieldById.get(fieldId)?.label ?? "Removed field"
                return `${label}: ${String(value)}`
              })
              .join(" · ")}
          </span>
        )
      },
    },
  ]
}

/** Form detail: header, tabbed overview/fields/submissions/activity, edit, delete. */
export default function FormDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [form, setForm] = useState<FormDetail | null>(null)
  const [submissions, setSubmissions] = useState<FormSubmission[]>([])
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [status, setStatus] = useState("draft")
  const [successMessage, setSuccessMessage] = useState("")
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [newLabel, setNewLabel] = useState("")
  const [newType, setNewType] = useState("text")
  const [newRequired, setNewRequired] = useState(false)
  const [newOptions, setNewOptions] = useState("")
  const [addingField, setAddingField] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<FormDetail>(`/api/v1/forms/${id}`)
      setForm(data)
      setName(data.name)
      setDescription(data.description ?? "")
      setStatus(data.status)
      setSuccessMessage(data.successMessage ?? "")
      const inbox = await apiFetchRaw<SubmissionsListResponse>(`/api/v1/forms/${id}/submissions`)
      setSubmissions(inbox.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this form.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch<FormDetail>(`/api/v1/forms/${id}`)
      setForm(data)
    } catch (err) {
      toast({
        title: "Refresh failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }, [id])

  const refreshSubmissions = useCallback(async () => {
    try {
      const inbox = await apiFetchRaw<SubmissionsListResponse>(`/api/v1/forms/${id}/submissions`)
      setSubmissions(inbox.data)
    } catch {
      // Submissions are secondary; the form itself already loaded.
    }
  }, [id])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const updated = await apiFetch<FormDetail>(`/api/v1/forms/${id}`, {
        method: "PATCH",
        body: {
          name: name.trim(),
          description: description.trim() === "" ? null : description.trim(),
          status,
          successMessage: successMessage.trim() === "" ? null : successMessage.trim(),
        },
      })
      setForm(updated)
      toast({ title: "Form updated" })
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/forms/${id}`, { method: "DELETE" })
      toast({ title: "Form deleted", description: "It can be restored from trash." })
      router.push("/app/forms")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  const addField = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newLabel.trim() === "") {
      toast({ title: "Field label is required" })
      return
    }
    setAddingField(true)
    try {
      await apiFetch(`/api/v1/forms/${id}/fields`, {
        method: "POST",
        body: {
          label: newLabel.trim(),
          fieldType: newType,
          required: newRequired,
          ...(newType === "select" && newOptions.trim() !== ""
            ? {
                options: newOptions
                  .split(",")
                  .map((o) => o.trim())
                  .filter((o) => o !== ""),
              }
            : {}),
        },
      })
      setNewLabel("")
      setNewType("text")
      setNewRequired(false)
      setNewOptions("")
      await refresh()
      toast({ title: "Field added" })
    } catch (err) {
      toast({
        title: "Could not add field",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setAddingField(false)
    }
  }

  const toggleRequired = async (field: FormField) => {
    try {
      await apiFetch(`/api/v1/forms/${id}/fields/${field.id}`, {
        method: "PATCH",
        body: { required: !field.required },
      })
      await refresh()
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  const moveField = async (index: number, delta: -1 | 1) => {
    if (!form) return
    const ordered = form.fields.map((f) => f.id)
    const next = index + delta
    if (next < 0 || next >= ordered.length) return
    const [moved] = ordered.splice(index, 1)
    if (moved) ordered.splice(next, 0, moved)
    try {
      await apiFetch(`/api/v1/forms/${id}/fields/reorder`, {
        method: "POST",
        body: { orderedIds: ordered },
      })
      await refresh()
    } catch (err) {
      toast({
        title: "Reorder failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  const deleteField = async (fieldId: string) => {
    try {
      await apiFetch(`/api/v1/forms/${id}/fields/${fieldId}`, { method: "DELETE" })
      await refresh()
      toast({ title: "Field removed" })
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading form">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || form === null) {
    return <ErrorState message={error ?? "This form does not exist."} onRetry={() => void load()} />
  }

  const fieldById = new Map(form.fields.map((f) => [f.id, f]))

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/forms" className="text-sm text-muted-foreground hover:underline">
        ← Back to forms
      </Link>
      <RecordHeader
        title={form.name}
        subtitle={form.description ?? "No description"}
        status={{
          label: form.status,
          tone: STATUS_TONES[form.status] ?? "secondary",
        }}
        owner={undefined}
        actions={
          <>
            {form.status !== "published" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setStatus("published")
                  void apiFetch(`/api/v1/forms/${id}`, {
                    method: "PATCH",
                    body: { status: "published" },
                  })
                    .then(() => refresh())
                    .catch((err: unknown) =>
                      toast({
                        title: "Publish failed",
                        description: err instanceof ApiError ? err.message : "Try again.",
                      }),
                    )
                }}
              >
                Publish
              </Button>
            ) : null}
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={setTab}
        ariaLabel="Form sections"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-6 py-4 lg:grid-cols-2">
                <section aria-label="Form properties" className="flex flex-col gap-4">
                  <div>
                    <h2 className="text-sm font-semibold">Details</h2>
                    <dl className="mt-2 flex flex-col gap-2 text-sm">
                      <div className="flex items-center gap-2">
                        <dt className="w-28 shrink-0 text-muted-foreground">Share token</dt>
                        <dd>
                          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                            {form.publicId}
                          </code>
                        </dd>
                      </div>
                      <div className="flex items-center gap-2">
                        <dt className="w-28 shrink-0 text-muted-foreground">Fields</dt>
                        <dd>
                          {form.fields.length === 0 ? (
                            "None yet — add them on the Fields tab."
                          ) : (
                            <span>
                              {form.fields.length} field{form.fields.length === 1 ? "" : "s"} (
                              {form.fields.filter((f) => f.required).length} required)
                            </span>
                          )}
                        </dd>
                      </div>
                      <div className="flex items-center gap-2">
                        <dt className="w-28 shrink-0 text-muted-foreground">Submissions</dt>
                        <dd>{submissions.length}</dd>
                      </div>
                      <div className="flex items-center gap-2">
                        <dt className="w-28 shrink-0 text-muted-foreground">Updated</dt>
                        <dd>{new Date(form.updatedAt).toLocaleString()}</dd>
                      </div>
                    </dl>
                  </div>
                  {form.successMessage ? (
                    <div className="flex flex-col gap-1">
                      <h3 className="text-sm font-semibold">Success message</h3>
                      <p className="whitespace-pre-wrap text-sm">{form.successMessage}</p>
                    </div>
                  ) : null}
                </section>
                <section aria-label="Edit form">
                  <h2 className="mb-3 text-sm font-semibold">Edit</h2>
                  <form onSubmit={save} className="flex flex-col gap-3">
                    <Field label="Name" htmlFor="form-name">
                      <TextField
                        id="form-name"
                        value={name}
                        onChange={(e) => setName(e.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Description" htmlFor="form-description">
                      <TextArea
                        id="form-description"
                        value={description}
                        onChange={(e) => setDescription(e.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Status" htmlFor="form-status">
                      <Select
                        id="form-status"
                        value={status}
                        onChange={(e) => setStatus(e.currentTarget.value)}
                        options={STATUS_OPTIONS}
                      />
                    </Field>
                    <Field label="Success message" htmlFor="form-success">
                      <TextArea
                        id="form-success"
                        value={successMessage}
                        onChange={(e) => setSuccessMessage(e.currentTarget.value)}
                        placeholder="Thanks! We will be in touch."
                      />
                    </Field>
                    <div>
                      <Button type="submit" disabled={saving}>
                        {saving ? "Saving…" : "Save changes"}
                      </Button>
                    </div>
                  </form>
                </section>
              </div>
            ),
          },
          {
            value: "fields",
            label: `Fields (${form.fields.length})`,
            content: (
              <div className="flex flex-col gap-4 py-4">
                {form.fields.length === 0 ? (
                  <EmptyState
                    title="No fields yet"
                    description="Add the first field below. Submissions validate required fields and types automatically."
                  />
                ) : (
                  <ul className="flex flex-col gap-2">
                    {form.fields.map((field, index) => (
                      <li
                        key={field.id}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3"
                      >
                        <span className="text-xs text-muted-foreground">#{index + 1}</span>
                        <span className="font-medium">{field.label}</span>
                        <Badge tone="secondary">{field.fieldType}</Badge>
                        {field.required ? <Badge tone="warning">Required</Badge> : null}
                        <span className="ml-auto flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={index === 0}
                            onClick={() => void moveField(index, -1)}
                            aria-label={`Move ${field.label} up`}
                          >
                            ↑
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={index === form.fields.length - 1}
                            onClick={() => void moveField(index, 1)}
                            aria-label={`Move ${field.label} down`}
                          >
                            ↓
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void toggleRequired(field)}
                          >
                            {field.required ? "Make optional" : "Make required"}
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => void deleteField(field.id)}
                          >
                            Remove
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <form
                  onSubmit={addField}
                  className="flex flex-col gap-3 rounded-md border border-border p-4"
                >
                  <h3 className="text-sm font-semibold">Add a field</h3>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Label" htmlFor="new-field-label" required>
                      <TextField
                        id="new-field-label"
                        value={newLabel}
                        onChange={(e) => setNewLabel(e.currentTarget.value)}
                        placeholder="Email address"
                      />
                    </Field>
                    <Field label="Type" htmlFor="new-field-type">
                      <Select
                        id="new-field-type"
                        value={newType}
                        onChange={(e) => setNewType(e.currentTarget.value)}
                        options={FIELD_TYPE_OPTIONS}
                      />
                    </Field>
                  </div>
                  {newType === "select" ? (
                    <Field label="Options (comma separated)" htmlFor="new-field-options">
                      <TextField
                        id="new-field-options"
                        value={newOptions}
                        onChange={(e) => setNewOptions(e.currentTarget.value)}
                        placeholder="Newsletter, Demo, Support"
                      />
                    </Field>
                  ) : null}
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={newRequired}
                      onChange={(e) => setNewRequired(e.currentTarget.checked)}
                      aria-label="Required field"
                    />
                    Required
                  </label>
                  <div>
                    <Button type="submit" disabled={addingField}>
                      {addingField ? "Adding…" : "Add field"}
                    </Button>
                  </div>
                </form>
              </div>
            ),
          },
          {
            value: "submissions",
            label: `Submissions (${submissions.length})`,
            content: (
              <div className="py-4">
                {submissions.length === 0 ? (
                  <EmptyState
                    title="No submissions yet"
                    description="Publish the form and share its token. Submissions appear here and stay linked for the later lead-creation pass."
                  />
                ) : (
                  <DataTable
                    rows={submissions}
                    columns={submissionColumns(fieldById)}
                    getRowId={(row) => row.id}
                  />
                )}
                {submissions.length > 0 ? (
                  <div className="mt-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void refreshSubmissions()}
                    >
                      Refresh
                    </Button>
                  </div>
                ) : null}
              </div>
            ),
          },
          {
            value: "activity",
            label: "Activity",
            content: (
              <div className="py-4">
                <Timeline
                  items={[
                    {
                      id: "created",
                      actor: "System",
                      timestamp: new Date(form.createdAt).toLocaleString(),
                      dateTime: form.createdAt,
                      body: "Form created.",
                    },
                    {
                      id: "updated",
                      actor: "System",
                      timestamp: new Date(form.updatedAt).toLocaleString(),
                      dateTime: form.updatedAt,
                      body: "Form last updated.",
                    },
                    ...submissions.slice(0, 10).map((s) => ({
                      id: s.id,
                      actor: s.submitterEmail ?? "Anonymous",
                      timestamp: new Date(s.createdAt).toLocaleString(),
                      dateTime: s.createdAt,
                      body: "Form submitted.",
                    })),
                  ]}
                />
              </div>
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${form.name}?`}
        description="The form moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
