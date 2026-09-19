import { describe, expect, test } from "bun:test"
import {
  buildMonthGrid,
  dateKeyOf,
  dayOfKey,
  isInMonth,
  monthLabel,
  monthRangeUtcPadded,
  shiftMonth,
} from "./calendar-math"

describe("calendar/calendar-math", () => {
  test("buildMonthGrid returns 42 keys starting on a Sunday", () => {
    // June 2026 starts on a Monday.
    const grid = buildMonthGrid(2026, 5)
    expect(grid).toHaveLength(42)
    expect(grid[0]).toBe("2026-05-31")
    expect(grid[1]).toBe("2026-06-01")
    expect(grid.at(-1)).toBe("2026-07-11")
  })

  test("dateKeyOf and dayOfKey round-trip", () => {
    expect(dateKeyOf(2026, 5, 9)).toBe("2026-06-09")
    expect(dayOfKey("2026-06-09")).toBe(9)
    expect(dayOfKey("2026-06-30")).toBe(30)
  })

  test("isInMonth distinguishes the current month from the padding days", () => {
    expect(isInMonth("2026-06-15", 2026, 5)).toBe(true)
    expect(isInMonth("2026-05-31", 2026, 5)).toBe(false)
    expect(isInMonth("2026-07-01", 2026, 5)).toBe(false)
  })

  test("monthRangeUtcPadded pads 8 days past the strict month bounds", () => {
    const { from, to } = monthRangeUtcPadded(2026, 5)
    expect(from).toBe("2026-05-24T00:00:00.000Z")
    expect(to).toBe("2026-07-09T00:00:00.000Z")
  })

  test("shiftMonth moves forward and backward, wrapping the year", () => {
    expect(shiftMonth(2026, 5, 1)).toEqual({ year: 2026, month: 6 })
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 })
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 })
  })

  test("monthLabel formats the human-readable month/year", () => {
    expect(monthLabel(2026, 5)).toBe("June 2026")
  })
})
