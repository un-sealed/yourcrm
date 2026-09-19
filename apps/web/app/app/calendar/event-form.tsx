"use client"

import { useState } from "react"
import { Button, Checkbox, DatePicker, Field, Select, TextArea, TextField } from "@yourcrm/ui"
import { fromWorkspaceLocalParts, toWorkspaceLocalParts } from "./local-time"
import type { AttendeeDraft, CalendarEventDetail } from "./types"

export type EventFormValues = {
  title: string
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  allDay: boolean
  location: string
  description: string
  status: "confirmed" | "cancelled"
  attendees: AttendeeDraft[]
}

export type EventFormSubmitPayload = {
  title: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string
  allDay: boolean
  status: "confirmed" | "cancelled"
  attendees: { userId?: string; email?: string }[]
}

const STATUS_OPTIONS = [
  { value: "confirmed", label: "Confirmed" },
  { value: "cancelled", label: "Cancelled" },
]

let attendeeKeySeq = 0
function nextAttendeeKey(): string {
  attendeeKeySeq += 1
  return `attendee-${attendeeKeySeq}`
}

/** Default form values: a one-hour timed event starting on the next half hour. */
export function defaultEventFormValues(): EventFormValues {
  const now = new Date()
  now.setMinutes(now.getMinutes() >= 30 ? 60 : 30, 0, 0)
  const date = now.toISOString().slice(0, 10)
  const time = now.toISOString().slice(11, 16)
  const end = new Date(now.getTime() + 60 * 60 * 1000)
  return {
    title: "",
    startDate: date,
    startTime: time,
    endDate: end.toISOString().slice(0, 10),
    endTime: end.toISOString().slice(11, 16),
    allDay: false,
    location: "",
    description: "",
    status: "confirmed",
    attendees: [],
  }
}

/** Seed form values from an existing event (edit), rendered in the workspace timezone. */
export function eventFormValuesFromDetail(
  event: CalendarEventDetail,
  timezone: string,
): EventFormValues {
  const start = toWorkspaceLocalParts(event.startAt, timezone)
  const end = toWorkspaceLocalParts(event.endAt, timezone)
  const pad = (n: number) => String(n).padStart(2, "0")
  return {
    title: event.title,
    startDate: `${start.year}-${pad(start.month)}-${pad(start.day)}`,
    startTime: `${pad(start.hour)}:${pad(start.minute)}`,
    endDate: `${end.year}-${pad(end.month)}-${pad(end.day)}`,
    endTime: `${pad(end.hour)}:${pad(end.minute)}`,
    allDay: event.allDay,
    location: event.location ?? "",
    description: event.description ?? "",
    status: event.status,
    attendees: event.attendees.map((a) => ({
      key: nextAttendeeKey(),
      kind: a.userId ? "internal" : "external",
      value: a.userId ?? a.email ?? "",
    })),
  }
}

function parseDateOnly(dateOnly: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateOnly.split("-").map(Number)
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 }
}

/** Convert form values (entered in the workspace timezone) into UTC ISO instants to submit. */
export function toSubmitPayload(values: EventFormValues, timezone: string): EventFormSubmitPayload {
  let startAt: Date
  let endAt: Date
  if (values.allDay) {
    const start = parseDateOnly(values.startDate)
    const end = parseDateOnly(values.endDate)
    startAt = new Date(Date.UTC(start.year, start.month - 1, start.day))
    // Inclusive end date -> exclusive UTC boundary (midnight the day after).
    endAt = new Date(Date.UTC(end.year, end.month - 1, end.day + 1))
  } else {
    const start = parseDateOnly(values.startDate)
    const [startHour, startMinute] = values.startTime.split(":").map(Number)
    const end = parseDateOnly(values.endDate)
    const [endHour, endMinute] = values.endTime.split(":").map(Number)
    startAt = fromWorkspaceLocalParts(
      { ...start, hour: startHour ?? 0, minute: startMinute ?? 0 },
      timezone,
    )
    endAt = fromWorkspaceLocalParts(
      { ...end, hour: endHour ?? 0, minute: endMinute ?? 0 },
      timezone,
    )
  }
  return {
    title: values.title.trim(),
    description: values.description.trim() === "" ? null : values.description.trim(),
    location: values.location.trim() === "" ? null : values.location.trim(),
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    allDay: values.allDay,
    status: values.status,
    attendees: values.attendees
      .filter((a) => a.value.trim() !== "")
      .map((a) => (a.kind === "internal" ? { userId: a.value.trim() } : { email: a.value.trim() })),
  }
}

export type EventFormProps = {
  values: EventFormValues
  onChange: (values: EventFormValues) => void
  onSubmit: () => void
  onCancel: () => void
  submitting: boolean
  submitLabel: string
  error: string | null
}

/** Create/edit form for a calendar event. Shared by `new/page.tsx` and `[id]/page.tsx`. */
export function EventForm({
  values,
  onChange,
  onSubmit,
  onCancel,
  submitting,
  submitLabel,
  error,
}: EventFormProps) {
  const [titleTouched, setTitleTouched] = useState(false)
  const set = <K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) =>
    onChange({ ...values, [key]: value })

  const addAttendee = (kind: AttendeeDraft["kind"]) =>
    set("attendees", [...values.attendees, { key: nextAttendeeKey(), kind, value: "" }])

  const updateAttendee = (key: string, value: string) =>
    set(
      "attendees",
      values.attendees.map((a) => (a.key === key ? { ...a, value } : a)),
    )

  const removeAttendee = (key: string) =>
    set(
      "attendees",
      values.attendees.filter((a) => a.key !== key),
    )

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        setTitleTouched(true)
        if (values.title.trim() === "") return
        onSubmit()
      }}
      className="flex flex-col gap-4"
    >
      <Field
        label="Title"
        htmlFor="event-title"
        required
        error={titleTouched && values.title.trim() === "" ? "Title is required." : error}
      >
        <TextField
          id="event-title"
          value={values.title}
          onChange={(e) => set("title", e.currentTarget.value)}
          placeholder="Kickoff call"
          required
          invalid={titleTouched && values.title.trim() === ""}
        />
      </Field>

      <Field label="All-day event" htmlFor="event-all-day">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            id="event-all-day"
            checked={values.allDay}
            onChange={(e) => set("allDay", e.currentTarget.checked)}
          />
          This event lasts all day
        </label>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Start date" htmlFor="event-start-date" required>
          <DatePicker
            id="event-start-date"
            value={values.startDate}
            onChange={(e) => set("startDate", e.currentTarget.value)}
            required
          />
        </Field>
        {values.allDay ? null : (
          <Field label="Start time" htmlFor="event-start-time" required>
            <TextField
              id="event-start-time"
              type="time"
              value={values.startTime}
              onChange={(e) => set("startTime", e.currentTarget.value)}
              required
            />
          </Field>
        )}
        <Field label="End date" htmlFor="event-end-date" required>
          <DatePicker
            id="event-end-date"
            value={values.endDate}
            onChange={(e) => set("endDate", e.currentTarget.value)}
            required
          />
        </Field>
        {values.allDay ? null : (
          <Field label="End time" htmlFor="event-end-time" required>
            <TextField
              id="event-end-time"
              type="time"
              value={values.endTime}
              onChange={(e) => set("endTime", e.currentTarget.value)}
              required
            />
          </Field>
        )}
      </div>

      <Field label="Location" htmlFor="event-location">
        <TextField
          id="event-location"
          value={values.location}
          onChange={(e) => set("location", e.currentTarget.value)}
          placeholder="Conference room, or a video link"
        />
      </Field>

      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
        <div className="mt-3 flex flex-col gap-4">
          <Field label="Status" htmlFor="event-status">
            <Select
              id="event-status"
              value={values.status}
              onChange={(e) => set("status", e.currentTarget.value as EventFormValues["status"])}
              options={STATUS_OPTIONS}
            />
          </Field>
          <Field label="Description" htmlFor="event-description">
            <TextArea
              id="event-description"
              value={values.description}
              onChange={(e) => set("description", e.currentTarget.value)}
              placeholder="Agenda, notes…"
            />
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Attendees</span>
            {values.attendees.length === 0 ? (
              <p className="text-xs text-muted-foreground">No attendees added yet.</p>
            ) : null}
            {values.attendees.map((attendee) => (
              <div key={attendee.key} className="flex items-center gap-2">
                <Select
                  aria-label="Attendee type"
                  value={attendee.kind}
                  onChange={(e) =>
                    set(
                      "attendees",
                      values.attendees.map((a) =>
                        a.key === attendee.key
                          ? { ...a, kind: e.currentTarget.value as AttendeeDraft["kind"] }
                          : a,
                      ),
                    )
                  }
                  options={[
                    { value: "internal", label: "Internal (user id)" },
                    { value: "external", label: "External (email)" },
                  ]}
                  className="w-48"
                />
                <TextField
                  aria-label={attendee.kind === "internal" ? "User id" : "Email"}
                  value={attendee.value}
                  onChange={(e) => updateAttendee(attendee.key, e.currentTarget.value)}
                  placeholder={attendee.kind === "internal" ? "user id" : "name@example.com"}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeAttendee(attendee.key)}
                  aria-label="Remove attendee"
                >
                  ✕
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => addAttendee("internal")}
              >
                Add internal attendee
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => addAttendee("external")}
              >
                Add external attendee
              </Button>
            </div>
          </div>
        </div>
      </details>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  )
}
