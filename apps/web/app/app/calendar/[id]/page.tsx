"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorState,
  RecordHeader,
  Skeleton,
  Tabs,
  Timeline,
  toast,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  eventFormValuesFromDetail,
  EventForm,
  toSubmitPayload,
  type EventFormValues,
} from "../event-form"
import { formatEventDateTime } from "../local-time"
import type { CalendarEventDetail, CalendarEventDetailResponse } from "../types"

/** Calendar event detail: header, tabbed overview/edit/activity, delete/restore. */
export default function CalendarEventDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [event, setEvent] = useState<CalendarEventDetail | null>(null)
  const [workspaceTimezone, setWorkspaceTimezone] = useState("UTC")
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [values, setValues] = useState<EventFormValues | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetchRaw<CalendarEventDetailResponse>(`/api/v1/calendar-events/${id}`)
      setEvent(res.data)
      setWorkspaceTimezone(res.workspaceTimezone)
      setValues(eventFormValuesFromDetail(res.data, res.workspaceTimezone))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this event.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    if (!values) return
    setSaveError(null)
    setSaving(true)
    try {
      const payload = toSubmitPayload(values, workspaceTimezone)
      await apiFetch(`/api/v1/calendar-events/${id}`, { method: "PATCH", body: payload })
      toast({ title: "Event updated" })
      await load()
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save changes.")
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/calendar-events/${id}`, { method: "DELETE" })
      toast({ title: "Event deleted", description: "It can be restored from trash." })
      router.push("/app/calendar")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading event">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || event === null || values === null) {
    return (
      <ErrorState message={error ?? "This event does not exist."} onRetry={() => void load()} />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/calendar" className="text-sm text-muted-foreground hover:underline">
        ← Back to calendar
      </Link>
      <RecordHeader
        title={event.title}
        subtitle={`${formatEventDateTime(event.startAt, workspaceTimezone)} – ${formatEventDateTime(
          event.endAt,
          workspaceTimezone,
        )} (${workspaceTimezone})`}
        status={{
          label: event.status,
          tone: event.status === "confirmed" ? "success" : "secondary",
        }}
        actions={
          <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        }
      />

      <Tabs
        value={tab}
        onValueChange={setTab}
        ariaLabel="Event sections"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-6 py-4 lg:grid-cols-2">
                <section aria-label="Event details" className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Details</h2>
                  <dl className="flex flex-col gap-2 text-sm">
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Location</dt>
                      <dd>{event.location ?? "—"}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">All-day</dt>
                      <dd>{event.allDay ? "Yes" : "No"}</dd>
                    </div>
                  </dl>
                  {event.description ? (
                    <div className="flex flex-col gap-1">
                      <h3 className="text-sm font-semibold">Description</h3>
                      <p className="whitespace-pre-wrap text-sm">{event.description}</p>
                    </div>
                  ) : null}
                  <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-semibold">Attendees</h3>
                    {event.attendees.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No attendees.</p>
                    ) : (
                      <ul className="flex flex-col gap-1 text-sm">
                        {event.attendees.map((a) => (
                          <li key={a.id} className="flex items-center gap-2">
                            <span>{a.userId ? `User ${a.userId}` : a.email}</span>
                            <Badge tone="secondary">{a.responseStatus}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </section>
                <section aria-label="Edit event">
                  <h2 className="mb-3 text-sm font-semibold">Edit</h2>
                  <EventForm
                    values={values}
                    onChange={setValues}
                    onSubmit={() => void save()}
                    onCancel={() => setValues(eventFormValuesFromDetail(event, workspaceTimezone))}
                    submitting={saving}
                    submitLabel="Save changes"
                    error={saveError}
                  />
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
                      timestamp: formatEventDateTime(event.createdAt, workspaceTimezone),
                      dateTime: event.createdAt,
                      body: "Event created.",
                    },
                    {
                      id: "updated",
                      actor: "System",
                      timestamp: formatEventDateTime(event.updatedAt, workspaceTimezone),
                      dateTime: event.updatedAt,
                      body: "Event last updated.",
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
        title={`Delete ${event.title}?`}
        description="The event moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
