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
  Dialog,
  ErrorState,
  Field,
  RecordHeader,
  Select,
  Skeleton,
  Tabs,
  TextArea,
  TextField,
  toast,
  type DataTableColumn,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  BOOKING_LINK_STATUS_TONES,
  WEEKDAY_LABELS,
  formatDateTime,
  labelToMinutes,
  minutesToLabel,
  type Booking,
  type BookingLinkDetail,
  type BookingsListResponse,
} from "../_components/model"

type RuleRow = { enabled: boolean; start: string; end: string }

const EMPTY_RULES: RuleRow[] = WEEKDAY_LABELS.map(() => ({
  enabled: false,
  start: "09:00",
  end: "17:00",
}))

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
]

function rulesFromLink(link: BookingLinkDetail): RuleRow[] {
  const rows = EMPTY_RULES.map((r) => ({ ...r }))
  for (const rule of link.rules) {
    const row = rows[rule.dayOfWeek]
    if (row) {
      row.enabled = true
      row.start = minutesToLabel(rule.startMinute)
      row.end = minutesToLabel(rule.endMinute)
    }
  }
  return rows
}

function bookingColumns(onCancel: (booking: Booking) => void): DataTableColumn<Booking>[] {
  return [
    {
      id: "when",
      header: "When (UTC)",
      accessor: (row) => new Date(row.startsAt).toLocaleString(),
    },
    {
      id: "invitee",
      header: "Invitee",
      accessor: (row) => (
        <span>
          {row.inviteeName} <span className="text-muted-foreground">({row.inviteeEmail})</span>
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      accessor: (row) => (
        <Badge tone={row.status === "confirmed" ? "success" : "secondary"}>{row.status}</Badge>
      ),
    },
    {
      id: "actions",
      header: "",
      accessor: (row) =>
        row.status === "confirmed" ? (
          <Button variant="outline" size="sm" onClick={() => onCancel(row)}>
            Cancel
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            {row.cancellationReason ?? "Cancelled"}
          </span>
        ),
    },
  ]
}

/** Booking link detail: header, tabbed overview/availability/bookings, edit, delete. */
export default function BookingLinkDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [link, setLink] = useState<BookingLinkDetail | null>(null)
  const [bookings, setBookings] = useState<Booking[]>([])
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [location, setLocation] = useState("")
  const [status, setStatus] = useState("active")
  const [durationMinutes, setDurationMinutes] = useState("30")
  const [bufferBeforeMinutes, setBufferBeforeMinutes] = useState("0")
  const [bufferAfterMinutes, setBufferAfterMinutes] = useState("0")
  const [minNoticeMinutes, setMinNoticeMinutes] = useState("60")
  const [maxDaysAhead, setMaxDaysAhead] = useState("30")
  const [saving, setSaving] = useState(false)

  const [rules, setRules] = useState<RuleRow[]>(EMPTY_RULES)
  const [rulesError, setRulesError] = useState<string | null>(null)
  const [savingRules, setSavingRules] = useState(false)

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<Booking | null>(null)
  const [cancelReason, setCancelReason] = useState("")
  const [cancelling, setCancelling] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<BookingLinkDetail>(`/api/v1/booking-links/${id}`)
      setLink(data)
      setTitle(data.title)
      setDescription(data.description ?? "")
      setLocation(data.location ?? "")
      setStatus(data.status)
      setDurationMinutes(String(data.durationMinutes))
      setBufferBeforeMinutes(String(data.bufferBeforeMinutes))
      setBufferAfterMinutes(String(data.bufferAfterMinutes))
      setMinNoticeMinutes(String(data.minNoticeMinutes))
      setMaxDaysAhead(String(data.maxDaysAhead))
      setRules(rulesFromLink(data))
      const list = await apiFetchRaw<BookingsListResponse>(
        `/api/v1/booking-links/${id}/bookings?limit=100`,
      )
      setBookings(list.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this booking link.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch<BookingLinkDetail>(`/api/v1/booking-links/${id}`)
      setLink(data)
    } catch (err) {
      toast({
        title: "Refresh failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }, [id])

  const refreshBookings = useCallback(async () => {
    try {
      const list = await apiFetchRaw<BookingsListResponse>(
        `/api/v1/booking-links/${id}/bookings?limit=100`,
      )
      setBookings(list.data)
    } catch {
      // Bookings are secondary; the link itself already loaded.
    }
  }, [id])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const updated = await apiFetch<BookingLinkDetail>(`/api/v1/booking-links/${id}`, {
        method: "PATCH",
        body: {
          title: title.trim(),
          description: description.trim() === "" ? null : description.trim(),
          location: location.trim() === "" ? null : location.trim(),
          status,
          durationMinutes: Number(durationMinutes) || 30,
          bufferBeforeMinutes: Number(bufferBeforeMinutes) || 0,
          bufferAfterMinutes: Number(bufferAfterMinutes) || 0,
          minNoticeMinutes: Number(minNoticeMinutes) || 0,
          maxDaysAhead: Number(maxDaysAhead) || 30,
        },
      })
      setLink((prev) => (prev ? { ...updated, rules: prev.rules } : null))
      toast({ title: "Booking link updated" })
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
      await apiFetch(`/api/v1/booking-links/${id}`, { method: "DELETE" })
      toast({ title: "Booking link deleted", description: "It can be restored from trash." })
      router.push("/app/booking-links")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  const updateRule = (day: number, patch: Partial<RuleRow>) => {
    setRules((prev) => prev.map((r, i) => (i === day ? { ...r, ...patch } : r)))
  }

  const saveRules = async (e: React.FormEvent) => {
    e.preventDefault()
    const parsed: { dayOfWeek: number; startMinute: number; endMinute: number }[] = []
    for (const [day, rule] of rules.entries()) {
      if (!rule.enabled) continue
      const start = labelToMinutes(rule.start)
      const end = labelToMinutes(rule.end)
      if (start === null || end === null || end <= start) {
        setRulesError(`${WEEKDAY_LABELS[day]}: enter a valid start/end time (end after start).`)
        return
      }
      parsed.push({ dayOfWeek: day, startMinute: start, endMinute: end })
    }
    setRulesError(null)
    setSavingRules(true)
    try {
      await apiFetch(`/api/v1/booking-links/${id}/rules`, {
        method: "PUT",
        body: { rules: parsed },
      })
      await refresh()
      toast({ title: "Availability updated" })
    } catch (err) {
      setRulesError(err instanceof ApiError ? err.message : "Could not save availability.")
    } finally {
      setSavingRules(false)
    }
  }

  const confirmCancel = async () => {
    if (!cancelTarget) return
    setCancelling(true)
    try {
      await apiFetch(`/api/v1/booking-links/${id}/bookings/${cancelTarget.id}/cancel`, {
        method: "POST",
        body: { reason: cancelReason.trim() === "" ? null : cancelReason.trim() },
      })
      setCancelTarget(null)
      setCancelReason("")
      await refreshBookings()
      toast({ title: "Booking cancelled" })
    } catch (err) {
      toast({
        title: "Cancel failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setCancelling(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading booking link">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || link === null) {
    return (
      <ErrorState
        message={error ?? "This booking link does not exist."}
        onRetry={() => void load()}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/booking-links" className="text-sm text-muted-foreground hover:underline">
        ← Back to booking links
      </Link>
      <RecordHeader
        title={link.title}
        subtitle={`/book/${link.slug}`}
        status={{ label: link.status, tone: BOOKING_LINK_STATUS_TONES[link.status] ?? "secondary" }}
        actions={
          <>
            <a
              href={`/book/${link.slug}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-primary hover:underline"
            >
              View public page ↗
            </a>
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={setTab}
        ariaLabel="Booking link sections"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <form onSubmit={save} className="grid gap-4 py-4 sm:grid-cols-2">
                <Field label="Title" htmlFor="bl-edit-title">
                  <TextField
                    id="bl-edit-title"
                    value={title}
                    onChange={(e) => setTitle(e.currentTarget.value)}
                  />
                </Field>
                <Field label="Status" htmlFor="bl-edit-status">
                  <Select
                    id="bl-edit-status"
                    value={status}
                    onChange={(e) => setStatus(e.currentTarget.value)}
                    options={STATUS_OPTIONS}
                  />
                </Field>
                <Field label="Duration (minutes)" htmlFor="bl-edit-duration">
                  <TextField
                    id="bl-edit-duration"
                    type="number"
                    min={5}
                    max={1440}
                    value={durationMinutes}
                    onChange={(e) => setDurationMinutes(e.currentTarget.value)}
                  />
                </Field>
                <Field label="Location" htmlFor="bl-edit-location">
                  <TextField
                    id="bl-edit-location"
                    value={location}
                    onChange={(e) => setLocation(e.currentTarget.value)}
                  />
                </Field>
                <Field label="Buffer before (minutes)" htmlFor="bl-edit-buffer-before">
                  <TextField
                    id="bl-edit-buffer-before"
                    type="number"
                    min={0}
                    max={120}
                    value={bufferBeforeMinutes}
                    onChange={(e) => setBufferBeforeMinutes(e.currentTarget.value)}
                  />
                </Field>
                <Field label="Buffer after (minutes)" htmlFor="bl-edit-buffer-after">
                  <TextField
                    id="bl-edit-buffer-after"
                    type="number"
                    min={0}
                    max={120}
                    value={bufferAfterMinutes}
                    onChange={(e) => setBufferAfterMinutes(e.currentTarget.value)}
                  />
                </Field>
                <Field label="Minimum notice (minutes)" htmlFor="bl-edit-min-notice">
                  <TextField
                    id="bl-edit-min-notice"
                    type="number"
                    min={0}
                    value={minNoticeMinutes}
                    onChange={(e) => setMinNoticeMinutes(e.currentTarget.value)}
                  />
                </Field>
                <Field label="Booking horizon (days ahead)" htmlFor="bl-edit-max-days">
                  <TextField
                    id="bl-edit-max-days"
                    type="number"
                    min={1}
                    max={365}
                    value={maxDaysAhead}
                    onChange={(e) => setMaxDaysAhead(e.currentTarget.value)}
                  />
                </Field>
                <Field label="Description" htmlFor="bl-edit-description" className="sm:col-span-2">
                  <TextArea
                    id="bl-edit-description"
                    value={description}
                    onChange={(e) => setDescription(e.currentTarget.value)}
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Button type="submit" disabled={saving}>
                    {saving ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              </form>
            ),
          },
          {
            value: "availability",
            label: "Availability",
            content: (
              <form onSubmit={saveRules} className="flex flex-col gap-4 py-4">
                <p className="text-sm text-muted-foreground">
                  Weekly hours, in your workspace timezone. Times outside these windows are never
                  offered to invitees.
                </p>
                <div className="flex flex-col gap-2">
                  {rules.map((rule, day) => (
                    <div key={WEEKDAY_LABELS[day]} className="flex flex-wrap items-center gap-2">
                      <label className="flex w-24 items-center gap-2 text-sm">
                        <Checkbox
                          checked={rule.enabled}
                          onChange={(e) => updateRule(day, { enabled: e.currentTarget.checked })}
                        />
                        {WEEKDAY_LABELS[day]}
                      </label>
                      <TextField
                        aria-label={`${WEEKDAY_LABELS[day]} start time`}
                        value={rule.start}
                        disabled={!rule.enabled}
                        onChange={(e) => updateRule(day, { start: e.currentTarget.value })}
                        className="w-24"
                      />
                      <span className="text-sm text-muted-foreground">to</span>
                      <TextField
                        aria-label={`${WEEKDAY_LABELS[day]} end time`}
                        value={rule.end}
                        disabled={!rule.enabled}
                        onChange={(e) => updateRule(day, { end: e.currentTarget.value })}
                        className="w-24"
                      />
                    </div>
                  ))}
                </div>
                {rulesError !== null ? (
                  <p role="alert" className="text-sm text-destructive">
                    {rulesError}
                  </p>
                ) : null}
                <div>
                  <Button type="submit" disabled={savingRules}>
                    {savingRules ? "Saving…" : "Save availability"}
                  </Button>
                </div>
              </form>
            ),
          },
          {
            value: "bookings",
            label: `Bookings (${bookings.length})`,
            content: (
              <div className="py-4">
                <DataTable
                  rows={bookings}
                  columns={bookingColumns((booking) => setCancelTarget(booking))}
                  getRowId={(row) => row.id}
                  empty={
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      No one has booked this link yet.
                    </p>
                  }
                />
              </div>
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${link.title}?`}
        description="The booking link moves to trash and can be restored. Existing bookings are unaffected."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />

      <Dialog
        open={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCancelTarget(null)
            setCancelReason("")
          }
        }}
        title={cancelTarget ? `Cancel ${cancelTarget.inviteeName}'s booking?` : "Cancel booking?"}
        description={
          cancelTarget
            ? `${formatDateTime(cancelTarget.startsAt, "UTC")} UTC. This also cancels the calendar event and frees the slot.`
            : undefined
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Reason (optional)" htmlFor="cancel-reason">
            <TextField
              id="cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.currentTarget.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={cancelling}
              onClick={() => {
                setCancelTarget(null)
                setCancelReason("")
              }}
            >
              Keep booking
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={cancelling}
              onClick={() => void confirmCancel()}
            >
              {cancelling ? "Cancelling…" : "Cancel booking"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
