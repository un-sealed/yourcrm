"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Badge,
  Button,
  ConfirmDialog,
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
} from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import { displayName, type PersonDetail } from "../types"

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
]

/** Person detail: header, tabbed overview/timeline, inline edit, delete. */
export default function PersonDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [person, setPerson] = useState<PersonDetail | null>(null)
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState("")
  const [status, setStatus] = useState("active")
  const [notes, setNotes] = useState("")
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<PersonDetail>(`/api/v1/people/${id}`)
      setPerson(data)
      setTitle(data.title ?? "")
      setStatus(data.status)
      setNotes(data.notes ?? "")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this person.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const updated = await apiFetch<PersonDetail>(`/api/v1/people/${id}`, {
        method: "PATCH",
        body: {
          title: title.trim() === "" ? null : title.trim(),
          status,
          notes: notes.trim() === "" ? null : notes.trim(),
        },
      })
      setPerson(updated)
      toast({ title: "Person updated" })
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
      await apiFetch(`/api/v1/people/${id}`, { method: "DELETE" })
      toast({ title: "Person deleted", description: "It can be restored from trash." })
      router.push("/app/people")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading person">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || person === null) {
    return (
      <ErrorState message={error ?? "This person does not exist."} onRetry={() => void load()} />
    )
  }

  const primaryEmail = person.emails.find((e) => e.isPrimary) ?? person.emails[0]
  const primaryPhone = person.phones.find((p) => p.isPrimary) ?? person.phones[0]

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/people" className="text-sm text-muted-foreground hover:underline">
        ← Back to people
      </Link>
      <RecordHeader
        title={displayName(person)}
        subtitle={person.title ?? "No title"}
        status={{
          label: person.status,
          tone: person.status === "active" ? "success" : "secondary",
        }}
        owner={undefined}
        actions={
          <>
            {primaryPhone ? (
              <a href={`tel:${primaryPhone.phone}`}>
                <Button variant="outline" size="sm">
                  Call
                </Button>
              </a>
            ) : null}
            {primaryEmail ? (
              <a href={`mailto:${primaryEmail.email}`}>
                <Button variant="outline" size="sm">
                  Email
                </Button>
              </a>
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
        ariaLabel="Person sections"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-6 py-4 lg:grid-cols-2">
                <section aria-label="Contact methods" className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Contact</h2>
                  {person.emails.length === 0 && person.phones.length === 0 ? (
                    <EmptyState
                      title="No contact methods"
                      description="Add an email or phone when you create or edit this person."
                    />
                  ) : (
                    <dl className="flex flex-col gap-2 text-sm">
                      {person.emails.map((email) => (
                        <div key={email.id} className="flex items-center gap-2">
                          <dt className="w-16 shrink-0 text-muted-foreground">
                            {email.label ?? "Email"}
                          </dt>
                          <dd>{email.email}</dd>
                          {email.isPrimary ? <Badge tone="secondary">Primary</Badge> : null}
                        </div>
                      ))}
                      {person.phones.map((phone) => (
                        <div key={phone.id} className="flex items-center gap-2">
                          <dt className="w-16 shrink-0 text-muted-foreground">
                            {phone.label ?? "Phone"}
                          </dt>
                          <dd>{phone.phone}</dd>
                          {phone.isPrimary ? <Badge tone="secondary">Primary</Badge> : null}
                        </div>
                      ))}
                    </dl>
                  )}
                  {person.notes ? (
                    <div className="flex flex-col gap-1">
                      <h3 className="text-sm font-semibold">Notes</h3>
                      <p className="whitespace-pre-wrap text-sm">{person.notes}</p>
                    </div>
                  ) : null}
                </section>
                <section aria-label="Edit person">
                  <h2 className="mb-3 text-sm font-semibold">Edit</h2>
                  <form onSubmit={save} className="flex flex-col gap-3">
                    <Field label="Job title" htmlFor="person-title">
                      <TextField
                        id="person-title"
                        value={title}
                        onChange={(e) => setTitle(e.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Status" htmlFor="person-status">
                      <Select
                        id="person-status"
                        value={status}
                        onChange={(e) => setStatus(e.currentTarget.value)}
                        options={STATUS_OPTIONS}
                      />
                    </Field>
                    <Field label="Notes" htmlFor="person-notes">
                      <TextArea
                        id="person-notes"
                        value={notes}
                        onChange={(e) => setNotes(e.currentTarget.value)}
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
            value: "activity",
            label: "Activity",
            content: (
              <div className="py-4">
                <Timeline
                  items={[
                    {
                      id: "created",
                      actor: "System",
                      timestamp: new Date(person.createdAt).toLocaleString(),
                      dateTime: person.createdAt,
                      body: "Person created.",
                    },
                    {
                      id: "updated",
                      actor: "System",
                      timestamp: new Date(person.updatedAt).toLocaleString(),
                      dateTime: person.updatedAt,
                      body: "Person last updated.",
                    },
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
        title={`Delete ${displayName(person)}?`}
        description="The person moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
