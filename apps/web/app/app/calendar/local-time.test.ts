import { describe, expect, test } from "bun:test"
import {
  formatEventDateTime,
  formatEventTime,
  fromWorkspaceLocalParts,
  localCalendarDateKey,
  toWorkspaceLocalParts,
} from "./local-time"

describe("calendar/local-time", () => {
  test("UTC timezone is the identity transform", () => {
    const parts = toWorkspaceLocalParts("2026-06-15T02:30:00.000Z", "UTC")
    expect(parts).toEqual({
      year: 2026,
      month: 6,
      day: 15,
      hour: 2,
      minute: 30,
      isoDate: "2026-06-15",
    })
  })

  // The classic calendar bug: a UTC-stored instant must roll back onto the
  // *previous* local calendar day for a workspace west of UTC.
  test("a UTC-stored event renders on the correct local day for a non-UTC workspace timezone", () => {
    const parts = toWorkspaceLocalParts("2026-06-15T02:30:00.000Z", "America/New_York")
    expect(parts.isoDate).toBe("2026-06-14")
    expect(parts.hour).toBe(22)
    expect(parts.minute).toBe(30)
  })

  test("localCalendarDateKey groups events by workspace-local day", () => {
    expect(localCalendarDateKey("2026-06-15T02:30:00.000Z", "America/New_York")).toBe("2026-06-14")
    expect(localCalendarDateKey("2026-06-15T02:30:00.000Z", "UTC")).toBe("2026-06-15")
  })

  test("formatEventDateTime and formatEventTime format the local wall clock", () => {
    const isoUtc = "2026-06-15T02:30:00.000Z"
    expect(formatEventDateTime(isoUtc, "America/New_York")).toBe("2026-06-14 22:30")
    expect(formatEventTime(isoUtc, "America/New_York")).toBe("22:30")
  })

  test("fromWorkspaceLocalParts is the exact inverse of toWorkspaceLocalParts", () => {
    const utc = fromWorkspaceLocalParts(
      { year: 2026, month: 6, day: 14, hour: 22, minute: 30 },
      "America/New_York",
    )
    expect(utc.toISOString()).toBe("2026-06-15T02:30:00.000Z")
  })

  test("throws on an invalid instant", () => {
    expect(() => toWorkspaceLocalParts("not-a-date", "UTC")).toThrow()
  })
})
