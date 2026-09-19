import type { FilterCondition, FilterFieldDef, FilterNode, FilterTree } from "@yourcrm/ui"

export type { FilterTree }

/**
 * Module-local list/detail model + read-side timezone rendering for the
 * Booking Links web UI (spec 48-booking-links, P0). Lives under
 * `_components/` because Next.js route modules (`page.tsx`) may only export
 * the default component — mirrors `app/app/forms/_components/model.ts`.
 *
 * TIMEZONE NOTE: `apps/web` has no `@yourcrm/crm` dependency (architecture
 * boundary — the web app talks to the API only), so the DST-aware
 * `Intl`-based wall-clock <-> UTC helpers are duplicated here rather than
 * imported, exactly like `app/app/calendar/local-time.ts` already does for
 * the calendar module (see its header comment for the full rationale). Both
 * booking-links routes (`/app/booking-links`, the public `/book/[slug]`)
 * import this single copy rather than each keeping their own.
 */

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export type BookingLink = {
  id: string
  workspaceId: string
  ownerId: string
  slug: string
  title: string
  description: string | null
  durationMinutes: number
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  minNoticeMinutes: number
  maxDaysAhead: number
  location: string | null
  status: string
  createdAt: string
  updatedAt: string
}

export type BookingAvailabilityRule = {
  id: string
  bookingLinkId: string
  dayOfWeek: number
  startMinute: number
  endMinute: number
}

export type BookingLinkDetail = BookingLink & { rules: BookingAvailabilityRule[] }

export type BookingLinksListResponse = {
  data: BookingLink[]
  pagination: { nextCursor: string | null; limit: number }
}

export type Booking = {
  id: string
  workspaceId: string
  bookingLinkId: string
  startsAt: string
  endsAt: string
  inviteeName: string
  inviteeEmail: string
  inviteeTimezone: string
  status: string
  calendarEventId: string | null
  notes: string | null
  cancellationReason: string | null
  createdAt: string
}

export type BookingsListResponse = {
  data: Booking[]
  pagination: { nextCursor: string | null; limit: number }
}

/** Public (unauthenticated) booking-link view — no owner/workspace identity. */
export type PublicBookingLink = {
  slug: string
  title: string
  description: string | null
  durationMinutes: number
  location: string | null
  workspaceTimezone: string
}

export type BookingSlot = {
  startAt: string
  endAt: string
}

export type PublicBooking = {
  id: string
  startsAt: string
  endsAt: string
  inviteeName: string
  inviteeEmail: string
  inviteeTimezone: string
  status: string
}

// ---------------------------------------------------------------------------
// List filters (mirrors app/app/forms/_components/model.ts)
// ---------------------------------------------------------------------------

export const BOOKING_LINK_FILTER_FIELDS: FilterFieldDef[] = [
  { name: "title", label: "Title", type: "text" },
  {
    name: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "active", label: "Active" },
      { value: "archived", label: "Archived" },
    ],
  },
]

export type BookingLinksListParams = {
  query?: string
  status?: string
}

export function treeToBookingLinksParams(tree: FilterTree): BookingLinksListParams {
  const params: BookingLinksListParams = {}
  const visit = (node: FilterNode): void => {
    if (node.type === "group") {
      for (const child of node.children) visit(child)
      return
    }
    const leaf = node as FilterCondition
    if (typeof leaf.value !== "string" || leaf.value.trim() === "") return
    if (leaf.field === "status" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if (value === "active" || value === "archived") params.status = value
      return
    }
    if (leaf.field === "title" && (leaf.operator === "contains" || leaf.operator === "eq")) {
      params.query = params.query === undefined ? leaf.value : `${params.query} ${leaf.value}`
    }
  }
  visit(tree)
  return params
}

export const BOOKING_LINK_STATUS_TONES: Record<string, "success" | "secondary" | "warning"> = {
  active: "success",
  archived: "secondary",
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

// ---------------------------------------------------------------------------
// Minute-of-day <-> "HH:MM" (weekly rule editor fields)
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** `540` -> `"09:00"`. */
export function minutesToLabel(minutes: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.round(minutes)))
  const hour = Math.floor(clamped / 60)
  const minute = clamped % 60
  return `${pad2(hour)}:${pad2(minute)}`
}

/** `"09:00"` -> `540`. Returns `null` for an unparseable label. */
export function labelToMinutes(label: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(label.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return null
  const total = hour * 60 + minute
  return total > 1440 ? null : total
}

// ---------------------------------------------------------------------------
// Read-side timezone rendering (duplicated from calendar's — see header note)
// ---------------------------------------------------------------------------

export type LocalDateTimeParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: string
  isoDate: string
}

/** Break a UTC instant into its local calendar/clock parts for `timeZone`. */
export function toLocalParts(isoUtc: string, timeZone: string): LocalDateTimeParts {
  const date = new Date(isoUtc)
  if (Number.isNaN(date.getTime())) throw new Error(`toLocalParts: invalid date "${isoUtc}"`)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ""
  const year = Number(get("year"))
  const month = Number(get("month"))
  const day = Number(get("day"))
  const rawHour = Number(get("hour"))
  const hour = rawHour === 24 ? 0 : rawHour
  const minute = Number(get("minute"))
  const weekday = get("weekday")
  return { year, month, day, hour, minute, weekday, isoDate: `${year}-${pad2(month)}-${pad2(day)}` }
}

/** `"Mon, Jun 15 · 09:00"`-style label for a slot button. */
export function formatSlotLabel(isoUtc: string, timeZone: string): string {
  const p = toLocalParts(isoUtc, timeZone)
  return `${p.weekday} ${pad2(p.month)}/${pad2(p.day)} · ${pad2(p.hour)}:${pad2(p.minute)}`
}

/** `"YYYY-MM-DD HH:mm"` in `timeZone`. */
export function formatDateTime(isoUtc: string, timeZone: string): string {
  const p = toLocalParts(isoUtc, timeZone)
  return `${p.isoDate} ${pad2(p.hour)}:${pad2(p.minute)}`
}

/** Best-effort browser IANA timezone (falls back to UTC). */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/** Today's local `YYYY-MM-DD` in `timeZone`. */
export function todayInTimezone(timeZone: string): string {
  return toLocalParts(new Date().toISOString(), timeZone).isoDate
}

/** Add (or subtract) whole calendar days to a `YYYY-MM-DD` string. */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number)
  const ms = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86_400_000
  const dt = new Date(ms)
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}
