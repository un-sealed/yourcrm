import { describe, expect, test } from "bun:test"
import {
  addCalendarDays,
  calendarDaysBetween,
  computeBookableSlots,
  isBookableSlot,
  weekdayOfCalendarDate,
} from "./slots"

describe("booking-links/slots helpers", () => {
  test("addCalendarDays steps calendar dates independent of timezone", () => {
    expect(addCalendarDays("2026-06-15", 1)).toBe("2026-06-16")
    expect(addCalendarDays("2026-06-15", -1)).toBe("2026-06-14")
    expect(addCalendarDays("2026-02-28", 1)).toBe("2026-03-01")
  })

  test("calendarDaysBetween counts whole calendar days", () => {
    expect(calendarDaysBetween("2026-06-15", "2026-06-20")).toBe(5)
    expect(calendarDaysBetween("2026-06-20", "2026-06-15")).toBe(-5)
    expect(calendarDaysBetween("2026-06-15", "2026-06-15")).toBe(0)
  })

  test("weekdayOfCalendarDate matches the real calendar (0=Sun..6=Sat)", () => {
    expect(weekdayOfCalendarDate("2026-06-15")).toBe(1) // Monday
    expect(weekdayOfCalendarDate("2026-06-16")).toBe(2) // Tuesday
    expect(weekdayOfCalendarDate("2026-06-14")).toBe(0) // Sunday
  })
})

describe("booking-links/computeBookableSlots", () => {
  const now = new Date("2026-06-01T00:00:00.000Z")

  test("generates 30-minute slots on the matching weekday within the rule window", () => {
    // Monday, 09:00-17:00 (540-1020 minutes), UTC workspace.
    const slots = computeBookableSlots({
      rules: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }],
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 0,
      maxDaysAhead: 365,
      workspaceTimezone: "UTC",
      rangeFromUtc: new Date("2026-06-15T00:00:00.000Z"),
      rangeToUtc: new Date("2026-06-15T23:59:59.999Z"),
      busy: [],
      now,
    })
    expect(slots).toHaveLength(16)
    expect(slots[0]).toEqual({
      startAt: "2026-06-15T09:00:00.000Z",
      endAt: "2026-06-15T09:30:00.000Z",
    })
    expect(slots.at(-1)).toEqual({
      startAt: "2026-06-15T16:30:00.000Z",
      endAt: "2026-06-15T17:00:00.000Z",
    })
  })

  test("excludes days that do not match the rule's weekday", () => {
    const slots = computeBookableSlots({
      rules: [{ dayOfWeek: 1, startMinute: 540, endMinute: 600 }],
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 0,
      maxDaysAhead: 365,
      workspaceTimezone: "UTC",
      rangeFromUtc: new Date("2026-06-16T00:00:00.000Z"), // Tuesday
      rangeToUtc: new Date("2026-06-16T23:59:59.999Z"),
      busy: [],
      now,
    })
    expect(slots).toEqual([])
  })

  test("is DST-aware: the same local 09:00 window lands at different UTC instants", () => {
    const rules = [{ dayOfWeek: 1, startMinute: 540, endMinute: 570 }] // Mon 09:00-09:30 local
    const winter = computeBookableSlots({
      rules,
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 0,
      maxDaysAhead: 3650,
      workspaceTimezone: "America/New_York",
      rangeFromUtc: new Date("2026-01-19T00:00:00.000Z"),
      rangeToUtc: new Date("2026-01-19T23:59:59.999Z"),
      busy: [],
      now: new Date("2026-01-01T00:00:00.000Z"),
    })
    const summer = computeBookableSlots({
      rules,
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 0,
      maxDaysAhead: 3650,
      workspaceTimezone: "America/New_York",
      rangeFromUtc: new Date("2026-06-15T00:00:00.000Z"),
      rangeToUtc: new Date("2026-06-15T23:59:59.999Z"),
      busy: [],
      now,
    })
    // EST = UTC-5 in January, EDT = UTC-4 in June.
    expect(winter[0]?.startAt).toBe("2026-01-19T14:00:00.000Z")
    expect(summer[0]?.startAt).toBe("2026-06-15T13:00:00.000Z")
  })

  test("applies buffers around busy intervals when checking overlap", () => {
    const opts = {
      rules: [{ dayOfWeek: 1, startMinute: 540, endMinute: 660 }], // 09:00-11:00
      durationMinutes: 30,
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 15,
      minNoticeMinutes: 0,
      maxDaysAhead: 365,
      workspaceTimezone: "UTC",
      rangeFromUtc: new Date("2026-06-15T00:00:00.000Z"),
      rangeToUtc: new Date("2026-06-15T23:59:59.999Z"),
      now,
    }
    // A meeting 09:30-10:00 with 15-minute buffers blocks 09:15-10:15, which
    // eliminates the 09:00 and 09:30 candidate slots (their buffered ranges
    // overlap) but leaves 10:00 too (09:30-10:00 buffered forward to 10:15,
    // so the 10:00-10:30 slot's buffered start of 09:45 still overlaps).
    const busy = [
      {
        startAt: new Date("2026-06-15T09:30:00.000Z"),
        endAt: new Date("2026-06-15T10:00:00.000Z"),
      },
    ]
    const slots = computeBookableSlots({ ...opts, busy })
    const starts = slots.map((s) => s.startAt)
    expect(starts).not.toContain("2026-06-15T09:00:00.000Z")
    expect(starts).not.toContain("2026-06-15T09:30:00.000Z")
    expect(starts).not.toContain("2026-06-15T10:00:00.000Z")
    expect(starts).toContain("2026-06-15T10:30:00.000Z")
  })

  test("excludes slots inside the minimum notice window", () => {
    const slots = computeBookableSlots({
      rules: [{ dayOfWeek: 1, startMinute: 0, endMinute: 1440 }],
      durationMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 120,
      maxDaysAhead: 365,
      workspaceTimezone: "UTC",
      rangeFromUtc: new Date("2026-06-15T00:00:00.000Z"),
      rangeToUtc: new Date("2026-06-15T23:59:59.999Z"),
      busy: [],
      now: new Date("2026-06-15T09:30:00.000Z"), // +2h notice = 11:30 threshold
    })
    // Hourly grid: 11:00 starts before the 11:30 threshold (excluded), so
    // the first bookable slot is 12:00.
    expect(slots[0]?.startAt).toBe("2026-06-15T12:00:00.000Z")
  })

  test("excludes slots beyond the booking horizon (maxDaysAhead)", () => {
    const slots = computeBookableSlots({
      rules: [
        { dayOfWeek: 1, startMinute: 540, endMinute: 600 },
        { dayOfWeek: 2, startMinute: 540, endMinute: 600 },
      ],
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 0,
      maxDaysAhead: 1,
      workspaceTimezone: "UTC",
      rangeFromUtc: new Date("2026-06-15T00:00:00.000Z"),
      rangeToUtc: new Date("2026-06-16T23:59:59.999Z"),
      busy: [],
      now: new Date("2026-06-15T00:00:00.000Z"),
    })
    // Only the Monday (day 0 ahead) slot survives; Tuesday is day 1 ahead
    // which is still <= maxDaysAhead, so both should actually appear —
    // tighten the horizon to prove the cutoff instead.
    const tightened = computeBookableSlots({
      rules: [
        { dayOfWeek: 1, startMinute: 540, endMinute: 600 },
        { dayOfWeek: 2, startMinute: 540, endMinute: 600 },
      ],
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 0,
      maxDaysAhead: 0,
      workspaceTimezone: "UTC",
      rangeFromUtc: new Date("2026-06-15T00:00:00.000Z"),
      rangeToUtc: new Date("2026-06-16T23:59:59.999Z"),
      busy: [],
      now: new Date("2026-06-15T00:00:00.000Z"),
    })
    expect(slots.length).toBeGreaterThan(tightened.length)
    expect(tightened.every((s) => s.startAt.startsWith("2026-06-15"))).toBe(true)
  })

  test("isBookableSlot matches an exact generated slot and rejects an off-grid instant", () => {
    const opts = {
      rules: [{ dayOfWeek: 1, startMinute: 540, endMinute: 600 }],
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 0,
      maxDaysAhead: 365,
      workspaceTimezone: "UTC",
      rangeFromUtc: new Date("2026-06-15T00:00:00.000Z"),
      rangeToUtc: new Date("2026-06-15T23:59:59.999Z"),
      busy: [],
      now,
    }
    expect(isBookableSlot(opts, new Date("2026-06-15T09:00:00.000Z"))).toBe(true)
    expect(isBookableSlot(opts, new Date("2026-06-15T09:15:00.000Z"))).toBe(false)
    expect(isBookableSlot(opts, new Date("2026-06-16T09:00:00.000Z"))).toBe(false)
  })
})
