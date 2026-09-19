"use client"

/**
 * Public booking page (spec 48-booking-links, P0) — unauthenticated, no
 * session. Mirrors the shape of the public login/signup pages: talks to the
 * API directly via `lib/api-client.ts`, no `@yourcrm/crm` import (the web
 * app never depends on domain packages — see `docs/architecture.md`).
 *
 * SAFETY: every response this page renders is a hand-built, public-safe DTO
 * from the API (`publicBookingLinkSchema` / `bookingSlotSchema` /
 * `publicBookingSchema`) — no owner email, no other invitee's details, no
 * calendar internals. See `apps/api/src/routes/modules/booking-links.ts`.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams } from "next/navigation"
import { Button, EmptyState, ErrorState, Field, Skeleton, TextArea, TextField } from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  addDays,
  browserTimezone,
  formatSlotLabel,
  todayInTimezone,
  type BookingSlot,
  type PublicBooking,
  type PublicBookingLink,
} from "../../app/booking-links/_components/model"

const DAYS_PER_PAGE = 7

export default function PublicBookingPage() {
  const params = useParams<{ slug: string }>()
  const slug = params.slug

  const [timezone] = useState(() => browserTimezone())
  const [link, setLink] = useState<PublicBookingLink | null>(null)
  const [loadingLink, setLoadingLink] = useState(true)
  const [linkError, setLinkError] = useState<string | null>(null)

  const [rangeStart, setRangeStart] = useState(() => todayInTimezone(browserTimezone()))
  const [slots, setSlots] = useState<BookingSlot[]>([])
  const [loadingSlots, setLoadingSlots] = useState(true)
  const [slotsError, setSlotsError] = useState<string | null>(null)
  const [selectedSlot, setSelectedSlot] = useState<BookingSlot | null>(null)

  const [inviteeName, setInviteeName] = useState("")
  const [inviteeEmail, setInviteeEmail] = useState("")
  const [notes, setNotes] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState<PublicBooking | null>(null)

  const rangeEnd = useMemo(() => addDays(rangeStart, DAYS_PER_PAGE - 1), [rangeStart])

  const loadLink = useCallback(async () => {
    setLoadingLink(true)
    setLinkError(null)
    try {
      const data = await apiFetch<PublicBookingLink>(`/api/v1/booking-links/public/${slug}`)
      setLink(data)
    } catch (err) {
      setLinkError(
        err instanceof ApiError && err.status === 404
          ? "This booking page does not exist or is no longer accepting bookings."
          : err instanceof ApiError
            ? err.message
            : "Could not load this booking page.",
      )
    } finally {
      setLoadingLink(false)
    }
  }, [slug])

  const loadSlots = useCallback(async () => {
    setLoadingSlots(true)
    setSlotsError(null)
    try {
      const qs = new URLSearchParams({ from: rangeStart, to: rangeEnd, timezone })
      const res = await apiFetchRaw<{ data: BookingSlot[] }>(
        `/api/v1/booking-links/public/${slug}/availability?${qs.toString()}`,
      )
      setSlots(res.data)
    } catch (err) {
      setSlotsError(err instanceof ApiError ? err.message : "Could not load available times.")
    } finally {
      setLoadingSlots(false)
    }
  }, [slug, rangeStart, rangeEnd, timezone])

  useEffect(() => {
    void loadLink()
  }, [loadLink])

  useEffect(() => {
    if (link) void loadSlots()
  }, [link, loadSlots])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedSlot) {
      setSubmitError("Choose a time first.")
      return
    }
    if (inviteeName.trim() === "" || inviteeEmail.trim() === "") {
      setSubmitError("Name and email are required.")
      return
    }
    setSubmitError(null)
    setSubmitting(true)
    try {
      const booking = await apiFetch<PublicBooking>(`/api/v1/booking-links/public/${slug}/book`, {
        method: "POST",
        body: {
          startAt: selectedSlot.startAt,
          inviteeName: inviteeName.trim(),
          inviteeEmail: inviteeEmail.trim(),
          inviteeTimezone: timezone,
          ...(notes.trim() === "" ? {} : { notes: notes.trim() }),
        },
      })
      setConfirmed(booking)
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.code === "CONFLICT" || err.code === "BOOKING_SLOT_UNAVAILABLE")
      ) {
        setSubmitError("Sorry — someone just booked that time. Pick another slot below.")
        setSelectedSlot(null)
        void loadSlots()
      } else {
        setSubmitError(err instanceof ApiError ? err.message : "Could not confirm the booking.")
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (loadingLink) {
    return (
      <div className="mx-auto flex min-h-screen max-w-lg flex-col gap-4 p-8" aria-busy="true">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (linkError !== null || link === null) {
    return (
      <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center p-8">
        <ErrorState
          message={linkError ?? "This booking page is unavailable."}
          onRetry={() => void loadLink()}
        />
      </div>
    )
  }

  if (confirmed) {
    return (
      <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-3 p-8 text-center">
        <h1 className="text-2xl font-semibold">You&apos;re booked!</h1>
        <p className="text-muted-foreground">
          {formatSlotLabel(confirmed.startsAt, timezone)} ({timezone})
        </p>
        <p className="text-sm text-muted-foreground">
          A calendar invite has been sent to {confirmed.inviteeEmail}.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col gap-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold">{link.title}</h1>
        {link.description ? <p className="mt-1 text-muted-foreground">{link.description}</p> : null}
        <p className="mt-2 text-sm text-muted-foreground">
          {link.durationMinutes} minutes{link.location ? ` · ${link.location}` : ""}
        </p>
      </div>

      <section aria-label="Choose a time" className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Pick a time <span className="font-normal text-muted-foreground">({timezone})</span>
          </h2>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={rangeStart <= todayInTimezone(timezone)}
              onClick={() => setRangeStart((d) => addDays(d, -DAYS_PER_PAGE))}
            >
              ← Earlier
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRangeStart((d) => addDays(d, DAYS_PER_PAGE))}
            >
              Later →
            </Button>
          </div>
        </div>

        {slotsError !== null ? (
          <ErrorState message={slotsError} onRetry={() => void loadSlots()} />
        ) : loadingSlots ? (
          <div
            className="grid grid-cols-2 gap-2"
            aria-busy="true"
            aria-label="Loading available times"
          >
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : slots.length === 0 ? (
          <EmptyState
            title="No times available"
            description="Try a later week."
            action={
              <Button
                type="button"
                variant="outline"
                onClick={() => setRangeStart((d) => addDays(d, DAYS_PER_PAGE))}
              >
                Later →
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {slots.map((slot) => (
              <Button
                key={slot.startAt}
                type="button"
                variant={selectedSlot?.startAt === slot.startAt ? "default" : "outline"}
                onClick={() => setSelectedSlot(slot)}
                aria-pressed={selectedSlot?.startAt === slot.startAt}
              >
                {formatSlotLabel(slot.startAt, timezone)}
              </Button>
            ))}
          </div>
        )}
      </section>

      {selectedSlot ? (
        <form onSubmit={submit} className="flex flex-col gap-3 rounded-md border p-4">
          <h2 className="text-sm font-semibold">
            Confirm {formatSlotLabel(selectedSlot.startAt, timezone)}
          </h2>
          <Field label="Your name" htmlFor="invitee-name" required error={submitError}>
            <TextField
              id="invitee-name"
              value={inviteeName}
              onChange={(e) => setInviteeName(e.currentTarget.value)}
              required
            />
          </Field>
          <Field label="Email" htmlFor="invitee-email" required>
            <TextField
              id="invitee-email"
              type="email"
              value={inviteeEmail}
              onChange={(e) => setInviteeEmail(e.currentTarget.value)}
              required
            />
          </Field>
          <Field label="Anything we should know?" htmlFor="invitee-notes">
            <TextArea
              id="invitee-notes"
              value={notes}
              onChange={(e) => setNotes(e.currentTarget.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setSelectedSlot(null)}>
              Back
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Booking…" : "Confirm booking"}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
