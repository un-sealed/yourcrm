"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  defaultEventFormValues,
  EventForm,
  toSubmitPayload,
  type EventFormValues,
} from "../event-form"
import type { CalendarEvent, CalendarEventListResponse } from "../types"

/** Create-event form: required fields first, advanced fields collapsible. */
export default function NewCalendarEventPage() {
  const router = useRouter()
  const [values, setValues] = useState<EventFormValues>(() => defaultEventFormValues())
  const [workspaceTimezone, setWorkspaceTimezone] = useState("UTC")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // The list endpoint is the only one that returns `workspaceTimezone`; a
  // single-row fetch is enough to learn it before the form needs to convert
  // entered wall-clock times to UTC.
  useEffect(() => {
    apiFetchRaw<CalendarEventListResponse>("/api/v1/calendar-events?limit=1")
      .then((res) => setWorkspaceTimezone(res.workspaceTimezone))
      .catch(() => {
        // Best-effort: fall back to UTC: forms still work, just without
        // workspace-local convenience until the next successful load.
      })
  }, [])

  const dirty =
    values.title !== "" ||
    values.location !== "" ||
    values.description !== "" ||
    values.attendees.length > 0
  useUnsavedGuard(dirty && !saving)

  const submit = async () => {
    setError(null)
    setSaving(true)
    try {
      const payload = toSubmitPayload(values, workspaceTimezone)
      const event = await apiFetch<CalendarEvent>("/api/v1/calendar-events", {
        method: "POST",
        body: payload,
      })
      toast({ title: "Event created", description: `${payload.title} was added.` })
      router.push(`/app/calendar/${event.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the event.")
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New event</h1>
        <Link href="/app/calendar" className="text-sm text-muted-foreground hover:underline">
          Back to calendar
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">
        Times are entered and shown in the workspace timezone ({workspaceTimezone}).
      </p>
      <EventForm
        values={values}
        onChange={setValues}
        onSubmit={() => void submit()}
        onCancel={() => router.push("/app/calendar")}
        submitting={saving}
        submitLabel="Create event"
        error={error}
      />
    </div>
  )
}
