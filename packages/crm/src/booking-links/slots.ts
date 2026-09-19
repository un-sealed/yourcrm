import { fromWorkspaceLocalParts, toWorkspaceLocalParts } from "../calendar"
import type { BookingAvailabilityRuleInput, BookingBusyInterval, BookingSlot } from "./types"

/**
 * Pure slot-generation logic for booking links (spec 48-booking-links, P0).
 *
 * Reuses the calendar module's DST-aware `Intl`-based timezone helpers
 * (`fromWorkspaceLocalParts` / `toWorkspaceLocalParts`) for every wall-clock
 * <-> UTC conversion — no date library, no second timezone implementation.
 * `toWorkspaceLocalParts` takes an arbitrary IANA zone despite its name, so
 * it doubles as the "render in the invitee's timezone" helper too.
 *
 * Availability rules are stored as weekday + minute-of-day windows in the
 * *workspace's* local timezone (`workspaces.timezone`); the invitee's
 * requested date range arrives in their own timezone and is converted to a
 * UTC instant range before this function ever sees it, then every candidate
 * slot generated from the (workspace-timezone) rule grid is filtered back
 * down to that same UTC range — so the final answer is correct regardless of
 * which timezone did the generating.
 */

const DAY_MS = 86_400_000

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** Add (or subtract) whole calendar days to a `YYYY-MM-DD` string, DST-independent. */
export function addCalendarDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number)
  const ms = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * DAY_MS
  const dt = new Date(ms)
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}

/** Integer number of calendar days from `a` to `b` (`b - a`), DST-independent. */
export function calendarDaysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number)
  const [by, bm, bd] = b.split("-").map(Number)
  const aMs = Date.UTC(ay ?? 1970, (am ?? 1) - 1, ad ?? 1)
  const bMs = Date.UTC(by ?? 1970, (bm ?? 1) - 1, bd ?? 1)
  return Math.round((bMs - aMs) / DAY_MS)
}

/** 0 (Sunday) .. 6 (Saturday) for a `YYYY-MM-DD` calendar date — timezone-independent. */
export function weekdayOfCalendarDate(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay()
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}

export type ComputeBookableSlotsOptions = {
  rules: BookingAvailabilityRuleInput[]
  durationMinutes: number
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  minNoticeMinutes: number
  maxDaysAhead: number
  /** IANA zone the availability rules are expressed in (`workspaces.timezone`). */
  workspaceTimezone: string
  rangeFromUtc: Date
  rangeToUtc: Date
  /** Existing commitments (own bookings + the owner's calendar events). */
  busy: BookingBusyInterval[]
  /** Clock override for tests. Defaults to `new Date()`. */
  now?: Date
  /** Safety cap on the number of slots returned. */
  maxSlots?: number
}

/**
 * Generate bookable slots for `[rangeFromUtc, rangeToUtc]` (inclusive of
 * slot start) from weekly availability rules, honoring buffers, minimum
 * notice and the booking horizon, and excluding anything that overlaps
 * `busy`. Sorted ascending by `startAt`.
 */
export function computeBookableSlots(opts: ComputeBookableSlotsOptions): BookingSlot[] {
  const now = opts.now ?? new Date()
  const nowMs = now.getTime()
  const minNoticeThresholdMs = nowMs + opts.minNoticeMinutes * 60_000
  const maxSlots = opts.maxSlots ?? 500
  const durationMs = opts.durationMinutes * 60_000
  const bufferBeforeMs = opts.bufferBeforeMinutes * 60_000
  const bufferAfterMs = opts.bufferAfterMinutes * 60_000
  const rangeFromMs = opts.rangeFromUtc.getTime()
  const rangeToMs = opts.rangeToUtc.getTime()

  const todayLocal = toWorkspaceLocalParts(now.toISOString(), opts.workspaceTimezone).isoDate
  // One extra calendar day of margin on each side absorbs timezone skew
  // between the (possibly different) range boundary zone and the workspace
  // zone the rule grid is generated in; the final UTC-instant filter below
  // trims anything that spills outside the true requested range.
  const startLocal = addCalendarDays(
    toWorkspaceLocalParts(opts.rangeFromUtc.toISOString(), opts.workspaceTimezone).isoDate,
    -1,
  )
  const endLocal = addCalendarDays(
    toWorkspaceLocalParts(opts.rangeToUtc.toISOString(), opts.workspaceTimezone).isoDate,
    1,
  )

  const slots: BookingSlot[] = []
  let cursor = startLocal
  // Bounded by construction (startLocal <= endLocal, both derived from a
  // finite range), but guard against a pathological caller-supplied range.
  let guard = 0
  while (cursor <= endLocal && guard < 10_000) {
    guard += 1
    const dayIndex = calendarDaysBetween(todayLocal, cursor)
    if (dayIndex > opts.maxDaysAhead) {
      cursor = addCalendarDays(cursor, 1)
      continue
    }
    const weekday = weekdayOfCalendarDate(cursor)
    const [y, m, d] = cursor.split("-").map(Number)
    for (const rule of opts.rules) {
      if (rule.dayOfWeek !== weekday) continue
      for (
        let minute = rule.startMinute;
        minute + opts.durationMinutes <= rule.endMinute;
        minute += opts.durationMinutes
      ) {
        const hour = Math.floor(minute / 60)
        const min = minute % 60
        const startDate = fromWorkspaceLocalParts(
          { year: y ?? 1970, month: m ?? 1, day: d ?? 1, hour, minute: min },
          opts.workspaceTimezone,
        )
        const startMs = startDate.getTime()
        if (startMs < minNoticeThresholdMs) continue
        if (startMs < rangeFromMs || startMs > rangeToMs) continue
        const endMs = startMs + durationMs
        const bufferedStart = startMs - bufferBeforeMs
        const bufferedEnd = endMs + bufferAfterMs
        const conflicts = opts.busy.some((b) =>
          overlaps(bufferedStart, bufferedEnd, b.startAt.getTime(), b.endAt.getTime()),
        )
        if (conflicts) continue
        slots.push({
          startAt: new Date(startMs).toISOString(),
          endAt: new Date(endMs).toISOString(),
        })
        if (slots.length >= maxSlots) {
          slots.sort((a, b) => a.startAt.localeCompare(b.startAt))
          return slots
        }
      }
    }
    cursor = addCalendarDays(cursor, 1)
  }
  slots.sort((a, b) => a.startAt.localeCompare(b.startAt))
  return slots
}

/** Whether `startAt` (a UTC instant) matches a real generated slot boundary. */
export function isBookableSlot(opts: ComputeBookableSlotsOptions, startAt: Date): boolean {
  return computeBookableSlots({
    ...opts,
    rangeFromUtc: startAt,
    rangeToUtc: startAt,
  }).some((s) => s.startAt === startAt.toISOString())
}
