"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button, Checkbox, Field, TextArea, TextField, toast } from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import { WEEKDAY_LABELS, labelToMinutes, type BookingLink } from "../_components/model"

type RuleRow = { enabled: boolean; start: string; end: string }

const DEFAULT_RULES: RuleRow[] = WEEKDAY_LABELS.map((_, day) => ({
  enabled: day >= 1 && day <= 5, // Mon-Fri by default
  start: "09:00",
  end: "17:00",
}))

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160)
}

/** Create-booking-link form: required fields first, advanced fields collapsible. */
export default function NewBookingLinkPage() {
  const router = useRouter()
  const [title, setTitle] = useState("")
  const [slug, setSlug] = useState("")
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState("")
  const [durationMinutes, setDurationMinutes] = useState("30")
  const [location, setLocation] = useState("")
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [bufferBeforeMinutes, setBufferBeforeMinutes] = useState("0")
  const [bufferAfterMinutes, setBufferAfterMinutes] = useState("0")
  const [minNoticeMinutes, setMinNoticeMinutes] = useState("60")
  const [maxDaysAhead, setMaxDaysAhead] = useState("30")
  const [ownerId, setOwnerId] = useState("")
  const [rules, setRules] = useState<RuleRow[]>(DEFAULT_RULES)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    apiFetchRaw<{ user: { id: string } }>("/api/v1/me")
      .then((session) => setOwnerId((current) => current || session.user.id))
      .catch(() => {
        // Not signed in yet (dev/test contexts) — leave ownerId blank for
        // manual entry; the server rejects the create if it's still empty.
      })
  }, [])

  const dirty = title !== "" || description !== "" || location !== ""
  useUnsavedGuard(dirty && !saving)

  const effectiveSlug = slugTouched ? slug : slugify(title)

  const updateRule = (day: number, patch: Partial<RuleRow>) => {
    setRules((prev) => prev.map((r, i) => (i === day ? { ...r, ...patch } : r)))
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (title.trim() === "") {
      setFieldError("Title is required.")
      return
    }
    if (effectiveSlug.length < 3) {
      setFieldError("Booking page URL must be at least 3 characters.")
      return
    }
    const duration = Number(durationMinutes)
    if (!Number.isInteger(duration) || duration < 5) {
      setFieldError("Duration must be at least 5 minutes.")
      return
    }
    if (ownerId.trim() === "") {
      setFieldError("Owner is required.")
      return
    }
    const parsedRules: { dayOfWeek: number; startMinute: number; endMinute: number }[] = []
    for (const [day, rule] of rules.entries()) {
      if (!rule.enabled) continue
      const start = labelToMinutes(rule.start)
      const end = labelToMinutes(rule.end)
      if (start === null || end === null || end <= start) {
        setFieldError(`${WEEKDAY_LABELS[day]}: enter a valid start/end time (end after start).`)
        return
      }
      parsedRules.push({ dayOfWeek: day, startMinute: start, endMinute: end })
    }
    setFieldError(null)
    setSaving(true)
    try {
      const link = await apiFetch<BookingLink>("/api/v1/booking-links", {
        method: "POST",
        body: {
          title: title.trim(),
          slug: effectiveSlug,
          ownerId: ownerId.trim(),
          durationMinutes: duration,
          bufferBeforeMinutes: Number(bufferBeforeMinutes) || 0,
          bufferAfterMinutes: Number(bufferAfterMinutes) || 0,
          minNoticeMinutes: Number(minNoticeMinutes) || 0,
          maxDaysAhead: Number(maxDaysAhead) || 30,
          ...(description.trim() === "" ? {} : { description: description.trim() }),
          ...(location.trim() === "" ? {} : { location: location.trim() }),
          rules: parsedRules,
        },
      })
      toast({ title: "Booking link created", description: `/book/${link.slug} is ready to share.` })
      router.push(`/app/booking-links/${link.id}`)
    } catch (err) {
      setFieldError(err instanceof ApiError ? err.message : "Could not create the booking link.")
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New booking link</h1>
        <Link href="/app/booking-links" className="text-sm text-muted-foreground hover:underline">
          Back to booking links
        </Link>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Title" htmlFor="bl-title" required error={fieldError}>
          <TextField
            id="bl-title"
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            placeholder="30 minute chat"
            required
          />
        </Field>
        <Field
          label="Booking page URL"
          htmlFor="bl-slug"
          required
          hint={`yourcrm.app/book/${effectiveSlug || "your-slug"}`}
        >
          <TextField
            id="bl-slug"
            value={effectiveSlug}
            onChange={(e) => {
              setSlugTouched(true)
              setSlug(slugify(e.currentTarget.value))
            }}
            placeholder="30-minute-chat"
          />
        </Field>
        <Field label="Duration (minutes)" htmlFor="bl-duration" required>
          <TextField
            id="bl-duration"
            type="number"
            min={5}
            max={1440}
            value={durationMinutes}
            onChange={(e) => setDurationMinutes(e.currentTarget.value)}
          />
        </Field>
        <Field label="Location" htmlFor="bl-location">
          <TextField
            id="bl-location"
            value={location}
            onChange={(e) => setLocation(e.currentTarget.value)}
            placeholder="Google Meet, phone, office…"
          />
        </Field>
        <Field label="Description" htmlFor="bl-description">
          <TextArea
            id="bl-description"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            placeholder="What is this meeting for?"
          />
        </Field>

        <fieldset className="flex flex-col gap-3 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">Weekly availability</legend>
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
                  placeholder="09:00"
                />
                <span className="text-sm text-muted-foreground">to</span>
                <TextField
                  aria-label={`${WEEKDAY_LABELS[day]} end time`}
                  value={rule.end}
                  disabled={!rule.enabled}
                  onChange={(e) => updateRule(day, { end: e.currentTarget.value })}
                  className="w-24"
                  placeholder="17:00"
                />
              </div>
            ))}
          </div>
        </fieldset>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-fit"
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          {advancedOpen ? "Hide advanced settings" : "Show advanced settings"}
        </Button>
        {advancedOpen ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Buffer before (minutes)" htmlFor="bl-buffer-before">
              <TextField
                id="bl-buffer-before"
                type="number"
                min={0}
                max={120}
                value={bufferBeforeMinutes}
                onChange={(e) => setBufferBeforeMinutes(e.currentTarget.value)}
              />
            </Field>
            <Field label="Buffer after (minutes)" htmlFor="bl-buffer-after">
              <TextField
                id="bl-buffer-after"
                type="number"
                min={0}
                max={120}
                value={bufferAfterMinutes}
                onChange={(e) => setBufferAfterMinutes(e.currentTarget.value)}
              />
            </Field>
            <Field label="Minimum notice (minutes)" htmlFor="bl-min-notice">
              <TextField
                id="bl-min-notice"
                type="number"
                min={0}
                value={minNoticeMinutes}
                onChange={(e) => setMinNoticeMinutes(e.currentTarget.value)}
              />
            </Field>
            <Field label="Booking horizon (days ahead)" htmlFor="bl-max-days">
              <TextField
                id="bl-max-days"
                type="number"
                min={1}
                max={365}
                value={maxDaysAhead}
                onChange={(e) => setMaxDaysAhead(e.currentTarget.value)}
              />
            </Field>
            <Field
              label="Owner (user id)"
              htmlFor="bl-owner"
              hint="Bookings create calendar events on this person's calendar. Defaults to you."
            >
              <TextField
                id="bl-owner"
                value={ownerId}
                onChange={(e) => setOwnerId(e.currentTarget.value)}
              />
            </Field>
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Link href="/app/booking-links" className="text-sm text-muted-foreground hover:underline">
            Cancel
          </Link>
          <Button type="submit" disabled={saving}>
            {saving ? "Creating…" : "Create booking link"}
          </Button>
        </div>
      </form>
    </div>
  )
}
