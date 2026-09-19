import { describe, expect, test } from "bun:test"
import {
  addDays,
  formatDateTime,
  formatSlotLabel,
  labelToMinutes,
  minutesToLabel,
  toLocalParts,
} from "./model"

describe("booking-links web model / minute-of-day labels", () => {
  test("minutesToLabel formats hh:mm, clamped to [0,1440]", () => {
    expect(minutesToLabel(540)).toBe("09:00")
    expect(minutesToLabel(0)).toBe("00:00")
    expect(minutesToLabel(1439)).toBe("23:59")
    expect(minutesToLabel(-5)).toBe("00:00")
    expect(minutesToLabel(5000)).toBe("24:00")
  })

  test("labelToMinutes is the inverse of minutesToLabel", () => {
    expect(labelToMinutes("09:00")).toBe(540)
    expect(labelToMinutes("23:59")).toBe(1439)
    expect(labelToMinutes("00:00")).toBe(0)
  })

  test("labelToMinutes rejects malformed input", () => {
    expect(labelToMinutes("not-a-time")).toBeNull()
    expect(labelToMinutes("25:00")).toBeNull()
    expect(labelToMinutes("09:60")).toBeNull()
  })
})

describe("booking-links web model / timezone rendering", () => {
  test("toLocalParts is DST-aware (matches packages/crm/src/calendar/timezone.ts)", () => {
    const winter = toLocalParts("2026-01-15T17:00:00.000Z", "America/New_York")
    const summer = toLocalParts("2026-07-15T17:00:00.000Z", "America/New_York")
    expect(winter.hour).toBe(12) // EST = UTC-5
    expect(summer.hour).toBe(13) // EDT = UTC-4
  })

  test("formatDateTime and formatSlotLabel render the local wall clock", () => {
    const isoUtc = "2026-06-15T13:00:00.000Z"
    expect(formatDateTime(isoUtc, "America/New_York")).toBe("2026-06-15 09:00")
    expect(formatSlotLabel(isoUtc, "America/New_York")).toContain("09:00")
    expect(formatSlotLabel(isoUtc, "America/New_York")).toContain("Mon")
  })

  test("addDays steps calendar dates", () => {
    expect(addDays("2026-06-15", 1)).toBe("2026-06-16")
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01")
  })
})
