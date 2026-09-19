import { describe, expect, test } from "bun:test"
import { formatCurrency, formatDate, formatScore, healthTone, lifecycleTone } from "./types"

describe("customer-success/types", () => {
  test("lifecycleTone maps every stage to a distinct, meaningful badge tone", () => {
    expect(lifecycleTone("healthy")).toBe("success")
    expect(lifecycleTone("at_risk")).toBe("warning")
    expect(lifecycleTone("churned")).toBe("destructive")
    expect(lifecycleTone("onboarding")).toBe("secondary")
    expect(lifecycleTone("adopting")).toBe("secondary")
  })

  test("healthTone buckets scores into success/warning/destructive", () => {
    expect(healthTone(100)).toBe("success")
    expect(healthTone(70)).toBe("success")
    expect(healthTone(69.9)).toBe("warning")
    expect(healthTone(40)).toBe("warning")
    expect(healthTone(39.9)).toBe("destructive")
    expect(healthTone(0)).toBe("destructive")
  })

  test("formatScore renders a whole number and handles missing values", () => {
    expect(formatScore("82.50")).toBe("83")
    expect(formatScore(82.5)).toBe("83")
    expect(formatScore(null)).toBe("—")
    expect(formatScore(undefined)).toBe("—")
    expect(formatScore("not-a-number")).toBe("—")
  })

  test("formatCurrency renders USD and handles missing/invalid values", () => {
    expect(formatCurrency("120000")).toBe("$120,000")
    expect(formatCurrency(null)).toBe("—")
    expect(formatCurrency("nope")).toBe("—")
  })

  test("formatDate renders a locale date string and handles missing/invalid values", () => {
    expect(formatDate(null)).toBe("—")
    expect(formatDate("")).toBe("—")
    expect(formatDate("not-a-date")).toBe("—")
    expect(formatDate("2026-12-01")).not.toBe("—")
  })
})
