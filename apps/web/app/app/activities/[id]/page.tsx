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
import type { ActivitiesListResponse, Activity } from "../_components/types"

const TYPE_OPTIONS = [
  { value: "note", label: "Note" },
  { value: "call", label: "Call" },
  { value: "meeting", label: "Meeting" },
  { value: "email", label: "Email" },
]

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
]

function statusTone(status: string): "success" | "secondary" | "warning" {
  if (status === "completed") return "success"
  if (status === "cancelled") return "secondary"
  return "warning"
}

/** Activity detail: header, tabbed overview/timeline, inline edit, complete, delete. */
export default function ActivityDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [activity, setActivity] = useState<Activity | null>(null)
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState("")
  const [type, setType] = useState("note")
  const [status, setStatus] = useState("open")
  const [body, setBody] = useState("")
  const [timelineItems, setTimelineItems] = useState<
    { id: string; actor: string; timestamp: string; dateTime: string; body: string }[]
  >([])
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<Activity>(`/api/v1/activities/${id}`)
      setActivity(data)
      setTitle(data.title)
      setType(data.type)
      setStatus(data.status)
      setBody(data.body ?? "")
      if (data.subjectType && data.subjectId) {
        try {
          const feed = await apiFetch<ActivitiesListResponse["data"]>(
            `/api/v1/activities/timeline?subjectType=${encodeURIComponent(data.subjectType)}&subjectId=${encodeURIComponent(data.subjectId)}`,
          )
          setTimelineItems(
            feed.map((item) => ({
              id: item.id,
              actor: "System",
              timestamp: new Date(item.createdAt).toLocaleString(),
              dateTime: item.createdAt,
              body: `${item.title} (${item.type}, ${item.status})`,
            })),
          )
        } catch {
          setTimelineItems([])
        }
      } else {
        setTimelineItems([
          {
            id: "created",
            actor: "System",
            timestamp: new Date(data.createdAt).toLocaleString(),
            dateTime: data.createdAt,
            body: "Activity created.",
          },
          {
            id: "updated",
            actor: "System",
            timestamp: new Date(data.updatedAt).toLocaleString(),
            dateTime: data.updatedAt,
            body: "Activity last updated.",
          },
        ])
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this activity.")
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
      const updated = await apiFetch<Activity>(`/api/v1/activities/${id}`, {
        method: "PATCH",
        body: {
          title: title.trim(),
          type,
          status,
          body: body.trim() === "" ? null : body.trim(),
        },
      })
      setActivity(updated)
      toast({ title: "Activity updated" })
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  const complete = async () => {
    try {
      const updated = await apiFetch<Activity>(`/api/v1/activities/${id}/complete`, {
        method: "POST",
      })
      setActivity(updated)
      setStatus(updated.status)
      toast({ title: "Activity completed" })
    } catch (err) {
      toast({
        title: "Complete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/activities/${id}`, { method: "DELETE" })
      toast({ title: "Activity deleted", description: "It can be restored from trash." })
      router.push("/app/activities")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading activity">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || activity === null) {
    return (
      <ErrorState message={error ?? "This activity does not exist."} onRetry={() => void load()} />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/activities" className="text-sm text-muted-foreground hover:underline">
        ← Back to activities
      </Link>
      <RecordHeader
        title={activity.title}
        subtitle={`${activity.type} · ${activity.status}`}
        status={{ label: activity.status, tone: statusTone(activity.status) }}
        owner={undefined}
        actions={
          <>
            {activity.status !== "completed" ? (
              <Button variant="outline" size="sm" onClick={() => void complete()}>
                Mark completed
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
        ariaLabel="Activity sections"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-6 py-4 lg:grid-cols-2">
                <section aria-label="Activity details" className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Details</h2>
                  <dl className="flex flex-col gap-2 text-sm">
                    <div className="flex items-center gap-2">
                      <dt className="w-20 shrink-0 text-muted-foreground">Type</dt>
                      <dd>
                        <Badge tone="secondary">{activity.type}</Badge>
                      </dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-20 shrink-0 text-muted-foreground">Status</dt>
                      <dd>
                        <Badge tone={statusTone(activity.status)}>{activity.status}</Badge>
                      </dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-20 shrink-0 text-muted-foreground">Subject</dt>
                      <dd>
                        {activity.subjectType ? (
                          <span>
                            {activity.subjectType} ·{" "}
                            <span className="text-muted-foreground">{activity.subjectId}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">No linked record</span>
                        )}
                      </dd>
                    </div>
                  </dl>
                  {activity.body ? (
                    <div className="flex flex-col gap-1">
                      <h3 className="text-sm font-semibold">Notes</h3>
                      <p className="whitespace-pre-wrap text-sm">{activity.body}</p>
                    </div>
                  ) : (
                    <EmptyState
                      title="No notes"
                      description="Add context to this activity with the edit form."
                    />
                  )}
                </section>
                <section aria-label="Edit activity">
                  <h2 className="mb-3 text-sm font-semibold">Edit</h2>
                  <form onSubmit={save} className="flex flex-col gap-3">
                    <Field label="Title" htmlFor="activity-title">
                      <TextField
                        id="activity-title"
                        value={title}
                        onChange={(e) => setTitle(e.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Type" htmlFor="activity-type">
                      <Select
                        id="activity-type"
                        value={type}
                        onChange={(e) => setType(e.currentTarget.value)}
                        options={TYPE_OPTIONS}
                      />
                    </Field>
                    <Field label="Status" htmlFor="activity-status">
                      <Select
                        id="activity-status"
                        value={status}
                        onChange={(e) => setStatus(e.currentTarget.value)}
                        options={STATUS_OPTIONS}
                      />
                    </Field>
                    <Field label="Notes" htmlFor="activity-body">
                      <TextArea
                        id="activity-body"
                        value={body}
                        onChange={(e) => setBody(e.currentTarget.value)}
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
            value: "timeline",
            label: "Timeline",
            content: (
              <div className="py-4">
                {timelineItems.length === 0 ? (
                  <EmptyState
                    title="No timeline entries"
                    description="Activities linked to this record will appear here."
                  />
                ) : (
                  <Timeline items={timelineItems} />
                )}
              </div>
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${activity.title}?`}
        description="The activity moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
