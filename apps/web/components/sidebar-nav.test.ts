import { describe, expect, test } from "bun:test"
import {
  defaultOpenGroups,
  formatNavCount,
  isActiveRoute,
  navItemAriaLabel,
  sectionHasActive,
} from "./sidebar-nav"
import { NAV_SECTIONS } from "./nav-sections"

describe("sidebar/isActiveRoute", () => {
  test("an exact match is current", () => {
    expect(isActiveRoute("/app/deals", "/app/deals")).toBe(true)
    expect(isActiveRoute("/app/deals", "/app/people")).toBe(false)
  })

  test("a nested route lights its parent", () => {
    expect(isActiveRoute("/app/settings/notifications", "/app/settings")).toBe(true)
  })

  test("a nested route that is itself an entry does not also light its parent", () => {
    // Both "/app/settings" and "/app/settings/onboarding" are nav entries.
    // Lighting both would show the user two current items at once.
    expect(isActiveRoute("/app/settings/onboarding", "/app/settings")).toBe(false)
    expect(isActiveRoute("/app/settings/onboarding", "/app/settings/onboarding")).toBe(true)
  })

  test("dashboard only ever matches exactly", () => {
    // Guards against "/app/dashboard" behaving as a prefix for the app.
    expect(isActiveRoute("/app/dashboard/anything", "/app/dashboard")).toBe(false)
    expect(isActiveRoute("/app/dashboard", "/app/dashboard")).toBe(true)
  })

  test("a partial path segment is not a prefix match", () => {
    // "/app/deals-archive" must not light "/app/deals".
    expect(isActiveRoute("/app/deals-archive", "/app/deals")).toBe(false)
  })
})

describe("sidebar/sectionHasActive", () => {
  const general = NAV_SECTIONS.find((section) => section.group === "General")
  const tools = NAV_SECTIONS.find((section) => section.group === "Tools")

  test("reports the group holding the current route", () => {
    if (general === undefined || tools === undefined) throw new Error("nav sections changed")
    expect(sectionHasActive("/app/deals", general)).toBe(true)
    expect(sectionHasActive("/app/deals", tools)).toBe(false)
  })

  test("an unknown route lights no group", () => {
    for (const section of NAV_SECTIONS) {
      expect(sectionHasActive("/app/nowhere", section)).toBe(false)
    }
  })
})

describe("sidebar/formatNavCount", () => {
  test("renders no badge for absent, zero or nonsense counts", () => {
    expect(formatNavCount(undefined)).toBeUndefined()
    expect(formatNavCount(0)).toBeUndefined()
    expect(formatNavCount(-3)).toBeUndefined()
    expect(formatNavCount(Number.NaN)).toBeUndefined()
  })

  test("abbreviates past three digits so the label keeps its room", () => {
    expect(formatNavCount(7)).toBe("7")
    expect(formatNavCount(999)).toBe("999")
    expect(formatNavCount(1000)).toBe("1k")
    expect(formatNavCount(1200)).toBe("1.2k")
    expect(formatNavCount(12_000)).toBe("9k+")
  })
})

describe("sidebar/defaultOpenGroups", () => {
  test("every group starts expanded", () => {
    const open = defaultOpenGroups(NAV_SECTIONS)
    expect(Object.keys(open)).toHaveLength(NAV_SECTIONS.length)
    expect(Object.values(open).every((value) => value)).toBe(true)
  })
})

describe("sidebar/navItemAriaLabel", () => {
  test("folds the count into the label so a badge is not colour-only", () => {
    expect(navItemAriaLabel({ href: "/app/inbox", label: "Inbox", count: 12 })).toBe("Inbox, 12")
    expect(navItemAriaLabel({ href: "/app/inbox", label: "Inbox" })).toBe("Inbox")
  })
})
