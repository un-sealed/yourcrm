import { describe, expect, test } from "bun:test"
import {
  formatEventDateTime,
  formatEventTime,
  fromWorkspaceLocalParts,
  localCalendarDateKey,
  toWorkspaceLocalParts,
} from "./timezone"

describe("calendar/timezone", () => {
  test("UTC timezone is the identity transform", () => {
    const parts = toWorkspaceLocalParts("2026-06-15T02:30:00.000Z", "UTC")
    expect(parts).toEqual({
      year: 2026,
      month: 6,
      day: 15,
      hour: 2,
      minute: 30,
      weekday: "Mon",
      isoDate: "2026-06-15",
    })
  })

  // The classic calendar bug: a UTC-stored instant must roll back onto the
  // *previous* local calendar day for a workspace west of UTC. Naive offset
  // math (or slicing the ISO string) gets this wrong around midnight.
  test("a UTC-stored event renders on the correct local day for a non-UTC workspace timezone", () => {
    const isoUtc = "2026-06-15T02:30:00.000Z" // 2026-06-15 02:30 UTC
    const parts = toWorkspaceLocalParts(isoUtc, "America/New_York") // EDT = UTC-4 in June
    expect(parts.isoDate).toBe("2026-06-14")
    expect(parts.hour).toBe(22)
    expect(parts.minute).toBe(30)
    expect(parts.weekday).toBe("Sun")
  })

  test("renders forward across the date line for a workspace east of UTC", () => {
    const isoUtc = "2026-01-01T23:00:00.000Z"
    const parts = toWorkspaceLocalParts(isoUtc, "Asia/Tokyo") // UTC+9, no DST
    expect(parts.isoDate).toBe("2026-01-02")
    expect(parts.hour).toBe(8)
  })

  test("is DST-aware: the same wall-clock UTC hour maps to different local offsets", () => {
    // Before the US spring-forward transition (2026-03-08 02:00 local EST->EDT).
    const winter = toWorkspaceLocalParts("2026-01-15T17:00:00.000Z", "America/New_York")
    const summer = toWorkspaceLocalParts("2026-07-15T17:00:00.000Z", "America/New_York")
    expect(winter.hour).toBe(12) // EST = UTC-5
    expect(summer.hour).toBe(13) // EDT = UTC-4
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

  test("throws on an invalid instant", () => {
    expect(() => toWorkspaceLocalParts("not-a-date", "UTC")).toThrow()
  })

  test("fromWorkspaceLocalParts is the exact inverse of toWorkspaceLocalParts", () => {
    // A form entering "2026-06-14 22:30" in a New York workspace should
    // store the same UTC instant the earlier "classic bug" test rendered.
    const utc = fromWorkspaceLocalParts(
      { year: 2026, month: 6, day: 14, hour: 22, minute: 30 },
      "America/New_York",
    )
    expect(utc.toISOString()).toBe("2026-06-15T02:30:00.000Z")
  })

  test("fromWorkspaceLocalParts round-trips through toWorkspaceLocalParts across DST", () => {
    for (const local of [
      { year: 2026, month: 1, day: 15, hour: 12, minute: 0 }, // winter, EST
      { year: 2026, month: 7, day: 15, hour: 12, minute: 0 }, // summer, EDT
    ]) {
      const utc = fromWorkspaceLocalParts(local, "America/New_York")
      const back = toWorkspaceLocalParts(utc.toISOString(), "America/New_York")
      expect(back).toMatchObject(local)
    }
  })

  test("fromWorkspaceLocalParts is the identity transform in UTC", () => {
    const utc = fromWorkspaceLocalParts(
      { year: 2026, month: 6, day: 15, hour: 2, minute: 30 },
      "UTC",
    )
    expect(utc.toISOString()).toBe("2026-06-15T02:30:00.000Z")
  })
})
